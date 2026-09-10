/*
 * Kavita — Kuma JavaScript source.
 *
 * Reads a Kavita server the user runs themselves. Like Komga there is no public
 * catalogue; unlike Komga the login is a token exchange, so authentication is
 * handled here rather than declared in the manifest.
 *
 * How auth works, and why it is split:
 *  - API calls need `Authorization: Bearer <jwt>`. The JWT comes from POSTing
 *    the user's API key to /api/Plugin/authenticate, so it cannot be a static
 *    header in the manifest. It is fetched once and cached, and refetched once
 *    if a call comes back 401 (tokens expire).
 *  - Images do NOT use the JWT. Kavita accepts `?apiKey=` on its image
 *    endpoints, which matters enormously: the reader fetches page images
 *    directly and never re-enters this file, so a header-only scheme would
 *    list chapters correctly and then fail on every page.
 *
 * The API key is the user's, from Kavita → Settings → Account → API Key. Kuma
 * never asks for their Kavita password.
 */

var PAGE_SIZE = 20;
var PLUGIN_NAME = 'Kuma';

// Kavita's MangaFormat. EPUB is text and its pages cannot be served as images,
// so those series are dropped rather than shown opening to nothing.
var FORMAT_EPUB = 3;

// Kavita's SeriesSortField.
var SORT_NAME = 1;
var SORT_LAST_CHAPTER_ADDED = 4;

function api(path) {
  return kuma.baseUrl + '/api' + path;
}

function apiKey() {
  return kuma.config.require('apiKey');
}

function query(pairs) {
  var parts = [];
  for (var i = 0; i < pairs.length; i++) {
    var value = pairs[i][1];
    if (value === null || value === undefined || value === '') continue;
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(value));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// MARK: - Authentication

var tokenCache = null;

function authenticate() {
  var url = api('/Plugin/authenticate') + query([
    ['apiKey', apiKey()],
    ['pluginName', PLUGIN_NAME]
  ]);
  var res = kuma.http.request('POST', url, '', {});
  if (!res.ok) {
    throw new Error(res.status === 401
      ? 'Kavita rejected that API key. Check it in Kavita under Settings → Account.'
      : (res.error || ('Could not sign in to Kavita (HTTP ' + res.status + ')')));
  }
  var body = JSON.parse(res.body);
  if (!body || !body.token) throw new Error('Kavita did not return a sign-in token.');
  tokenCache = body.token;
  return tokenCache;
}

function token() {
  return tokenCache || authenticate();
}

function authHeaders(extra) {
  var headers = { 'Authorization': 'Bearer ' + token() };
  for (var k in (extra || {})) headers[k] = extra[k];
  return headers;
}

/**
 * Runs a request, and retries once after re-authenticating on a 401.
 *
 * Kavita's tokens expire. Without this a source that worked yesterday throws
 * today and stays broken until the app is relaunched.
 */
function send(method, url, body, extra) {
  var res = kuma.http.request(method, url, body || '', authHeaders(extra));
  if (res.status === 401) {
    tokenCache = null;
    res = kuma.http.request(method, url, body || '', authHeaders(extra));
  }
  if (!res.ok) throw new Error(res.error || ('Kavita returned HTTP ' + res.status));
  return JSON.parse(res.body);
}

// MARK: - Libraries

var libraryIdCache = null;

function libraryId() {
  var wanted = kuma.config.get('library');
  if (!wanted) return null;
  if (libraryIdCache !== null) return libraryIdCache || null;

  var libraries = [];
  try {
    libraries = send('GET', api('/Library/libraries'), null, null) || [];
  } catch (e) {
    // Browsing everything beats refusing to browse because one optional
    // lookup failed.
    libraryIdCache = '';
    return null;
  }

  var target = String(wanted).toLowerCase();
  for (var i = 0; i < libraries.length; i++) {
    if (String(libraries[i].name || '').toLowerCase() === target) {
      libraryIdCache = libraries[i].id;
      return libraryIdCache;
    }
  }
  libraryIdCache = '';
  return null;
}

// MARK: - Mapping

// Kavita has no per-series status, only metadata. Claiming otherwise would put
// a wrong "Ongoing" on every title.
function decodeSeries(series) {
  if (!series) return null;
  var id = series.id !== undefined ? series.id : series.seriesId;
  if (id === undefined || id === null) return null;

  return {
    url: '/series/' + id,
    title: series.name || series.originalName || 'Untitled',
    // apiKey in the URL, because the reader fetches covers without a header.
    thumbnailUrl: api('/Image/series-cover') + query([['seriesId', id], ['apiKey', apiKey()]]),
    status: 'Unknown'
  };
}

function isReadable(series) {
  return Number(series && series.format) !== FORMAT_EPUB;
}

function inChosenLibrary(series, chosen) {
  if (chosen === null || chosen === undefined || chosen === '') return true;
  return String(series && series.libraryId) === String(chosen);
}

function seriesId(url) {
  var match = kuma.regex.first('/series/([^/?#]+)', '', String(url || ''));
  return match || String(url || '').replace(/^\/+/, '');
}

function decodeChapter(chapter) {
  if (!chapter || chapter.id === undefined) return null;

  var number = parseFloat(chapter.minNumber);
  if (isNaN(number)) number = parseFloat(chapter.number);
  if (isNaN(number)) number = parseFloat(chapter.range);

  var title = chapter.titleName || chapter.title || '';
  var label;
  if (chapter.isSpecial) {
    label = title || 'Special';
  } else if (isNaN(number)) {
    label = title || String(chapter.range || 'Chapter');
  } else {
    label = title ? number + ' - ' + title : 'Chapter ' + number;
  }

  var uploaded = null;
  if (chapter.releaseDate) {
    var parsed = Date.parse(chapter.releaseDate);
    // Kavita writes 0001-01-01 for "no date", which parses to a real but
    // absurd timestamp and would sort every such chapter to the beginning.
    //
    // Screening on `parsed > 0` instead would look right and be wrong: dates
    // before 1970 are negative, and golden-age comics — the exact thing people
    // self-host — are all from the 1940s.
    if (!isNaN(parsed) && new Date(parsed).getUTCFullYear() > 1000) uploaded = parsed;
  }

  return {
    // Pages are derived from the count, so it travels in the url and
    // getPageList needs no extra request.
    url: '/chapter/' + chapter.id + '/' + (chapter.pages || 0),
    name: label,
    chapterNumber: isNaN(number) ? null : number,
    dateUpload: uploaded
  };
}

// MARK: - Browsing

function listSeries(page, sortField, ascending) {
  var url = api('/Series/all-v2') + query([
    ['PageNumber', page],
    // Over-fetch so client-side format filtering still fills a page. Asking
    // for exactly 20 and dropping ebooks leaves short pages, and the host
    // reads a short page as "no more results".
    ['PageSize', PAGE_SIZE * 3]
  ]);
  var body = JSON.stringify({
    combination: 1,
    limitTo: 0,
    sortOptions: { sortField: sortField, isAscending: !!ascending }
  });

  var results = send('POST', url, body, { 'Content-Type': 'application/json' }) || [];
  var chosen = libraryId();
  var out = [];
  for (var i = 0; i < results.length && out.length < PAGE_SIZE; i++) {
    if (!isReadable(results[i])) continue;
    if (!inChosenLibrary(results[i], chosen)) continue;
    var mapped = decodeSeries(results[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

// MARK: - Source

var KumaSource = {
  // Kavita has no popularity ranking, so alphabetical is the honest default.
  fetchPopular: function (page) {
    return listSeries(page, SORT_NAME, true);
  },

  fetchLatest: function (page) {
    return listSeries(page, SORT_LAST_CHAPTER_ADDED, false);
  },

  fetchSearch: function (query_, page) {
    var url = api('/Search/search') + query([
      ['queryString', query_],
      ['includeChapterAndFiles', 'false']
    ]);
    var body = send('GET', url, null, null) || {};
    var chosen = libraryId();
    var out = [];
    var series = body.series || [];
    for (var i = 0; i < series.length; i++) {
      if (!isReadable(series[i])) continue;
      if (!inChosenLibrary(series[i], chosen)) continue;
      var mapped = decodeSeries(series[i]);
      if (mapped) out.push(mapped);
    }
    return out;
  },

  getMangaDetails: function (url) {
    var id = seriesId(url);
    var series = send('GET', api('/Series/' + id), null, null);
    var details = decodeSeries(series) || {};

    // Metadata is a second call; a server that refuses it should still show
    // the title rather than failing the whole screen.
    try {
      var meta = send('GET', api('/Series/metadata') + query([['seriesId', id]]), null, null) || {};
      var genres = [];
      for (var i = 0; i < (meta.genres || []).length; i++) genres.push(meta.genres[i].title);
      for (var j = 0; j < (meta.tags || []).length; j++) genres.push(meta.tags[j].title);
      details.genres = genres;
      details.description = meta.summary || '';
      if ((meta.writers || []).length) details.author = meta.writers[0].name;
      if ((meta.coverArtists || []).length) details.artist = meta.coverArtists[0].name;
    } catch (e) {
      details.genres = [];
    }
    return details;
  },

  getChapterList: function (url) {
    var detail = send('GET', api('/Series/series-detail') + query([['seriesId', seriesId(url)]]), null, null) || {};

    // Kavita splits the same chapters across several arrays depending on how
    // the series is organised — volumes for numbered runs, `chapters` for
    // loose ones, `specials` for the rest. Collect all three and dedupe by id
    // rather than guessing which one this series uses.
    var seen = {};
    var out = [];

    function collect(list) {
      for (var i = 0; i < (list || []).length; i++) {
        var chapter = list[i];
        if (!chapter || chapter.id === undefined || seen[chapter.id]) continue;
        seen[chapter.id] = true;
        var mapped = decodeChapter(chapter);
        if (mapped) out.push(mapped);
      }
    }

    var volumes = detail.volumes || [];
    for (var v = 0; v < volumes.length; v++) collect(volumes[v].chapters);
    collect(detail.chapters);
    collect(detail.specials);

    out.sort(function (a, b) {
      var left = a.chapterNumber === null ? -1 : a.chapterNumber;
      var right = b.chapterNumber === null ? -1 : b.chapterNumber;
      return right - left;
    });
    return out;
  },

  getPageList: function (chapterUrl) {
    var raw = String(chapterUrl || '');
    var id = kuma.regex.first('/chapter/([^/?#]+)', '', raw);
    var count = parseInt(kuma.regex.first('/chapter/[^/]+/(\\d+)', '', raw), 10);

    // The page count travelled in the url from getChapterList. Only ask the
    // server when it didn't — an extra round trip before every chapter opens
    // is a visible delay on a self-hosted server over a slow link.
    if (isNaN(count) || count <= 0) {
      var info = send('GET', api('/Reader/chapter-info') + query([['chapterId', id]]), null, null) || {};
      count = parseInt(info.pages, 10);
    }
    if (isNaN(count) || count <= 0) return [];

    var key = apiKey();
    var out = [];
    // Kavita numbers pages from zero.
    for (var page = 0; page < count; page++) {
      out.push({ url: api('/Reader/image') + query([['chapterId', id], ['page', page], ['apiKey', key]]) });
    }
    return out;
  }
};
