/*
 * Komga — Kuma JavaScript source.
 *
 * Reads a Komga server the user runs themselves. There is no public catalogue:
 * the address and login come from the source's settings, which the host
 * collects before it will register this source at all.
 *
 * Runtime notes (see JSHostBridge.swift):
 *  - `kuma.baseUrl` is already the user's server, not the manifest placeholder.
 *  - Authentication is NOT done here. The manifest declares `auth: basic`, so
 *    the host puts the header on every request — including page images, which
 *    the reader fetches directly and which would otherwise all 401.
 *  - Everything is synchronous; `kuma.http.getJSON` blocks this source's thread.
 */

var PAGE_SIZE = 20;

// MARK: - Libraries
//
// A Komga server routinely holds ebooks next to comics — the stock demo server
// ships exactly that, a "Comics" library and an "eBooks" one. Kuma cannot
// render a text EPUB, and those books return an empty page list, so a novel
// would appear on the shelf and open to nothing. The optional library setting
// is how a user with a mixed server points at just their comics.
var libraryIdCache = null;

function libraryId() {
  var wanted = kuma.config.get('library');
  if (!wanted) return null;
  if (libraryIdCache !== null) return libraryIdCache || null;

  var libraries = [];
  try {
    libraries = kuma.http.getJSON(api('/libraries')) || [];
  } catch (e) {
    // An old or locked-down server may not expose this. Browsing everything
    // beats refusing to browse at all.
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

// Only comic archives have pages Kuma can show. `mediaProfile` is the modern
// signal; older servers only report a media type.
function isReadable(book) {
  var media = (book && book.media) || {};
  if (media.status && media.status !== 'READY') return false;
  if (media.mediaProfile) return media.mediaProfile === 'DIVINA';
  return String(media.mediaType || '').indexOf('epub') === -1;
}

// Komga pages are 0-based; Kuma's are 1-based.
function apiPage(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 0 : n - 1;
}

function api(path) {
  return kuma.baseUrl + '/api/v1' + path;
}

function query(pairs) {
  var parts = [];
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i][1] === null || pairs[i][1] === undefined || pairs[i][1] === '') continue;
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// MARK: - Mapping

// Komga's vocabulary is its own; SMangaStatus raw values are fixed by the host.
function statusOf(value) {
  switch (String(value || '').toUpperCase()) {
    case 'ONGOING': return 'Ongoing';
    case 'ENDED': return 'Finished';
    case 'HIATUS': return 'On Hiatus';
    // ABANDONED has no equivalent, and guessing "Completed" would be a lie.
    default: return 'Unknown';
  }
}

function decodeSeries(series) {
  if (!series || !series.id) return null;
  var meta = series.metadata || {};
  var books = series.booksMetadata || {};
  var authors = [];
  for (var i = 0; i < (books.authors || []).length; i++) {
    var person = books.authors[i];
    if (person && person.name && authors.indexOf(person.name) === -1) authors.push(person.name);
  }

  return {
    url: '/series/' + series.id,
    title: meta.title || series.name || 'Untitled',
    // The thumbnail needs the same auth header as everything else, which the
    // host adds because SourceImage sends the source's headers.
    thumbnailUrl: api('/series/' + series.id + '/thumbnail'),
    author: authors.length ? authors[0] : null,
    artist: authors.length > 1 ? authors[1] : null,
    description: meta.summary || books.summary || '',
    genres: (meta.genres || []).concat(meta.tags || []),
    status: statusOf(meta.status)
  };
}

function seriesId(url) {
  var match = kuma.regex.first('/series/([^/?#]+)', '', String(url || ''));
  return match || String(url || '').replace(/^\/+/, '');
}

function decodeBook(book) {
  if (!book || !book.id) return null;
  var meta = book.metadata || {};
  var number = parseFloat(meta.numberSort);
  if (isNaN(number)) number = parseFloat(book.number);

  var name = meta.title && meta.title !== book.name ? meta.title : book.name;
  var label = isNaN(number) ? name : 'Chapter ' + number;
  if (meta.title && meta.title !== String(number)) label = isNaN(number) ? name : number + ' - ' + meta.title;

  var uploaded = null;
  if (meta.releaseDate) {
    var parsed = Date.parse(meta.releaseDate);
    if (!isNaN(parsed)) uploaded = parsed;
  }
  if (uploaded === null && book.fileLastModified) {
    var modified = Date.parse(book.fileLastModified);
    if (!isNaN(modified)) uploaded = modified;
  }

  return {
    url: '/books/' + book.id,
    name: label,
    chapterNumber: isNaN(number) ? null : number,
    dateUpload: uploaded
  };
}

function listSeries(page, sort, search) {
  var url = api('/series') + query([
    ['page', apiPage(page)],
    ['size', PAGE_SIZE],
    ['sort', sort],
    ['search', search],
    ['library_id', libraryId()],
    // A deleted series still lists but cannot be read.
    ['deleted', 'false']
  ]);
  var body = kuma.http.getJSON(url);
  var out = [];
  var content = (body && body.content) || [];
  for (var i = 0; i < content.length; i++) {
    var mapped = decodeSeries(content[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

// MARK: - Source

var KumaSource = {
  // Komga has no notion of popularity, so alphabetical is the honest default
  // for "browse everything on my server".
  fetchPopular: function (page) {
    return listSeries(page, 'metadata.titleSort,asc', null);
  },

  fetchLatest: function (page) {
    return listSeries(page, 'lastModified,desc', null);
  },

  fetchSearch: function (query, page) {
    return listSeries(page, 'metadata.titleSort,asc', query);
  },

  getMangaDetails: function (url) {
    var body = kuma.http.getJSON(api('/series/' + seriesId(url)));
    return decodeSeries(body) || {};
  },

  getChapterList: function (url) {
    // One request rather than paging: a personal library's series runs to
    // hundreds of books at most, and the host has no paging for chapters.
    var body = kuma.http.getJSON(api('/series/' + seriesId(url) + '/books') + query([
      ['size', 1000],
      ['sort', 'metadata.numberSort,desc'],
      ['deleted', 'false']
    ]));
    var out = [];
    var content = (body && body.content) || [];
    for (var i = 0; i < content.length; i++) {
      if (!isReadable(content[i])) continue;
      var mapped = decodeBook(content[i]);
      if (mapped) out.push(mapped);
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var bookId = kuma.regex.first('/books/([^/?#]+)', '', String(chapterUrl || ''))
      || String(chapterUrl || '').replace(/^\/+/, '');
    var pages = kuma.http.getJSON(api('/books/' + bookId + '/pages'));
    var out = [];
    for (var i = 0; i < (pages || []).length; i++) {
      var number = pages[i] && pages[i].number;
      if (number === null || number === undefined) continue;
      out.push({ url: api('/books/' + bookId + '/pages/' + number) });
    }
    return out;
  }
};
