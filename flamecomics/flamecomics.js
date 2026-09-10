/*
 * Flame Comics — Kuma JavaScript source.
 *
 * A Next.js site, which sounds like the client-rendered ones this project
 * skips — but it isn't. Next.js embeds the page's data as plain JSON in a
 * `<script id="__NEXT_DATA__">` tag, a documented and stable shape, rather
 * than a framework-private serialization. So every screen here is read from
 * JSON, not from markup, and no selector can drift.
 *
 * Reading the JSON also sidesteps a trap the markup has: the reader injects
 * "read on Flame" banner images alongside the real pages. Scraping `<img>`
 * would pick those up as pages; the JSON lists only the chapter's own images.
 *
 * The catalogue arrives whole on `/browse` and search is done in the browser,
 * so both browsing and searching work off one cached response.
 */

var PAGE_SIZE = 30;

// Covers and pages live on a CDN subdomain of the site.
function cdn() {
  return kuma.baseUrl.replace('://', '://cdn.') + '/uploads/images/series';
}

/**
 * The `__NEXT_DATA__` payload for a page.
 *
 * Throws rather than returning empty: if this tag is missing, the site has
 * moved off the Pages Router and every screen is broken, which is worth
 * saying once rather than showing four empty shelves.
 */
function nextData(path) {
  var body = kuma.http.get(kuma.baseUrl + path);
  var raw = kuma.regex.first('<script id="__NEXT_DATA__"[^>]*>([\\s\\S]*?)</script>', '', body);
  if (!raw) throw new Error('Flame Comics changed how its pages are built; this source needs updating.');

  try {
    return JSON.parse(raw).props.pageProps || {};
  } catch (e) {
    throw new Error('Flame Comics sent something unreadable.');
  }
}

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

function seriesId(url) {
  var match = kuma.regex.first('/series/(\\d+)', '', String(url || ''));
  return match || String(url || '').replace(/^\/+/, '');
}

function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('ongoing') >= 0) return 'Ongoing';
  if (text.indexOf('completed') >= 0) return 'Completed';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  if (text.indexOf('drop') >= 0 || text.indexOf('cancel') >= 0) return 'Unknown';
  return 'Unknown';
}

function decodeSeries(entry) {
  if (!entry || entry.series_id === undefined) return null;
  var cover = entry.cover || 'thumbnail.png';
  return {
    url: '/series/' + entry.series_id,
    title: entry.title || 'Untitled',
    thumbnailUrl: cdn() + '/' + entry.series_id + '/' + cover,
    status: statusOf(entry.status)
  };
}

// `/browse` returns the entire catalogue in one response and the site filters
// it in the browser, so one fetch serves both browsing and searching.
var catalogueCache = null;

function catalogue() {
  if (!catalogueCache) {
    var data = nextData('/browse');
    catalogueCache = data.series || [];
  }
  return catalogueCache;
}

function slice(entries, page) {
  var start = (pageNumber(page) - 1) * PAGE_SIZE;
  var out = [];
  for (var i = start; i < entries.length && out.length < PAGE_SIZE; i++) {
    var mapped = decodeSeries(entries[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

var KumaSource = {
  fetchPopular: function (page) {
    return slice(catalogue(), page);
  },

  // The recent block lives on the home page and is a fixed shelf, so later
  // pages end rather than repeat it.
  fetchLatest: function (page) {
    if (pageNumber(page) > 1) return [];

    var data = nextData('/');
    var blocks = (data.latestEntries && data.latestEntries.blocks) || [];
    var out = [];
    var seen = {};

    for (var b = 0; b < blocks.length; b++) {
      var entries = blocks[b].series || [];
      for (var i = 0; i < entries.length; i++) {
        var mapped = decodeSeries(entries[i]);
        if (!mapped || seen[mapped.url]) continue;
        seen[mapped.url] = true;
        out.push(mapped);
      }
    }
    return out;
  },

  // The site searches in the browser, so this filters the cached catalogue
  // rather than asking the server — `?search=` is ignored server-side and
  // would quietly return everything.
  fetchSearch: function (text, page) {
    var needle = String(text || '').toLowerCase();
    if (!needle) return [];

    var matches = [];
    var all = catalogue();
    for (var i = 0; i < all.length; i++) {
      var entry = all[i];
      var title = String(entry.title || '').toLowerCase();
      if (title.indexOf(needle) >= 0) { matches.push(entry); continue; }
      // Alternative titles matter here: a lot of these are known by their
      // Korean or Japanese name as well as the English one.
      var alts = entry.altTitles || [];
      for (var a = 0; a < alts.length; a++) {
        if (String(alts[a] || '').toLowerCase().indexOf(needle) >= 0) { matches.push(entry); break; }
      }
    }
    return slice(matches, page);
  },

  getMangaDetails: function (url) {
    var id = seriesId(url);
    var data = nextData('/series/' + id);
    var series = data.series || {};

    var details = decodeSeries(series) || { url: '/series/' + id };
    details.genres = series.tags || [];
    // Descriptions are stored as HTML, tags and all. Passed through as-is
    // the reader shows "<p class=\"mantine-focus-auto\">…" above the synopsis.
    if (series.description) details.description = kuma.stripTags(series.description);
    // Both arrive as arrays; the reader wants one name.
    if ((series.author || []).length) details.author = series.author[0];
    if ((series.artist || []).length) details.artist = series.artist[0];
    return details;
  },

  getChapterList: function (url) {
    var id = seriesId(url);
    var data = nextData('/series/' + id);
    var chapters = data.chapters || [];

    var out = [];
    var seen = {};
    for (var i = 0; i < chapters.length; i++) {
      var chapter = chapters[i];
      if (!chapter || !chapter.token) continue;
      if (seen[chapter.token]) continue;
      seen[chapter.token] = true;

      var number = parseFloat(chapter.chapter);
      var label = 'Chapter ' + (isNaN(number) ? chapter.chapter : number);
      if (chapter.title) label += ' - ' + chapter.title;

      // release_date is seconds; the host wants milliseconds.
      var released = parseInt(chapter.release_date, 10);

      out.push({
        url: '/series/' + id + '/' + chapter.token,
        name: label,
        chapterNumber: isNaN(number) ? null : number,
        dateUpload: isNaN(released) || released <= 0 ? null : released * 1000
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.charAt(0) !== '/') path = '/' + path;
    var data = nextData(path);
    var chapter = data.chapter || {};
    var images = chapter.images || {};

    // Keyed by index as strings, so ordering has to be numeric — "10" sorts
    // before "2" otherwise, and the chapter reads out of order.
    var keys = [];
    for (var key in images) {
      if (Object.prototype.hasOwnProperty.call(images, key)) keys.push(key);
    }
    keys.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });

    var base = cdn() + '/' + chapter.series_id + '/' + chapter.token + '/';
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var image = images[keys[i]];
      if (image && image.name) out.push({ url: base + image.name });
    }
    return out;
  }
};
