/*
 * Keyoapp — one Kuma source bundle for every site on the Keyoapp platform.
 *
 * Keyoapp is not a theme a group installs, it is a hosted service groups sign
 * up to. The vendor owns the markup, the routes and the image CDN, so every
 * site on it is byte-for-byte the same application with a different logo.
 * That is why this file takes **no options at all**: nine sites were walked
 * end to end while writing it and nothing varied but the address.
 *
 * Four things about the platform this file exists to get right, every one of
 * which fails silently if you guess:
 *
 *  1. **A page's `src` is a placeholder SVG.** Every reader image ships as
 *     `<img src="/assets/images/placeholder.svg" uid="...">` and the site's own
 *     script swaps in `https://cdn.meowing.org/uploads/{uid}`. Read `src` (or
 *     `data-src`, the usual lazy-load habit) and you get a chapter of identical
 *     grey placeholders that load perfectly. The uid is the only real source.
 *  2. **A cover is a CSS `background-image`, not an `<img>`.** It lives in a
 *     `style` attribute, sometimes under the custom property `--photoURL`
 *     instead of `background-image`. Nothing else in this repo reads a URL out
 *     of a style attribute; `urlFromStyle` is that, and it is unit-tested.
 *  3. **A row's own text is not its title.** The listing card's text is its
 *     genre badges; the outer `<button>`'s `title` has the alternative titles
 *     glued on ("Host Lady 호스트 레이디"). Only the anchor's `title`/`alt` is
 *     the clean one. And a row links its series twice — once around the cover,
 *     once around the heading — so rows are keyed by id and merged.
 *  4. **Coin-locked chapters serve no pages.** A paid chapter's reader has no
 *     `#pages` element whatsoever, so it would open as a blank chapter. They
 *     are recognised by a lock icon in the chapter row and dropped from the
 *     list, rather than listed and then found to be empty.
 *
 * Search is client-side on these sites: `/search_series` returns the entire
 * catalogue as one HTML fragment and the page filters it in the browser. This
 * file does the same — fetch once, filter, paginate — which is why searching
 * works at all here and why `LISTING_CACHE` exists (paging without it would
 * re-download a megabyte per screen).
 */

// How many rows a page of results holds. The site paginates nothing; every
// listing endpoint returns its whole list, so paging happens here.
var PAGE_SIZE = 24;

// The platform's shared image host. Every site verified serves its pages from
// this one CDN — it belongs to Keyoapp, not to the scanlation group — and the
// reader's own `loadImage()` builds exactly this string from the uid.
var PAGE_CDN = 'https://cdn.meowing.org/uploads/';

var SELECTORS = {
  // Listings. One selector serves the catalogue fragment, the catalogue page
  // and the latest-updates page, because all three are grids of the same card.
  seriesLink: "a[href*='/series/']",
  styled: 'div[style]',

  // Series page.
  detailTitle: 'h1',
  detailCover: "div[style*='--photoURL']",
  detailDescription: '#expand_content p',
  detailStatus: "div[title='Status']",
  detailGenre: "a[href*='genre=']",

  // Chapter list. Scoped to #chapters because the page header carries its own
  // "Start reading" and "Latest chapter" links to the same URLs.
  chapterRow: "#chapters a[href*='/chapter/']",
  // A paid chapter draws a lock over its thumbnail. It is the only <img> in a
  // row whose src mentions a lock, the rest being the coin badge.
  lockIcon: "img[src*='lock']",

  // Reader.
  pageImage: '#pages img[uid]'
};

// MARK: - Identifiers

/**
 * The series segment of a href.
 *
 * Returns nothing for `/series/` and `/series/?genre=drama`, which is what
 * keeps the catalogue's own genre filter links out of the results. Sites
 * differ on whether the segment is a hex id (`65b4edfd962`) or a slug
 * (`the-villainous-dukes-daughter`) — both are opaque here, which is why this
 * takes whatever the href gave rather than validating a shape.
 */
function seriesIdFrom(href) {
  return kuma.regex.first('/series/([^/?#]+)', '', String(href || ''));
}

function chapterIdFrom(href) {
  return kuma.regex.first('/chapter/([^/?#]+)', '', String(href || ''));
}

// MARK: - Style attributes

/**
 * The image URL inside a `style` attribute.
 *
 * Covers are CSS backgrounds on this platform, and in two spellings: the cards
 * use `background-image:url(...)` and the series page uses a custom property,
 * `--photoURL:url(...)`. Both are matched by name first so that a rule listing
 * some other `url()` ahead of the cover cannot win; the bare `url(...)` match
 * is a fallback for a spelling we have not seen.
 *
 * Whitespace is stripped rather than trimmed — a URL split across lines in the
 * attribute would otherwise resolve to a 404 while still looking like a cover.
 */
function urlFromStyle(style) {
  var text = String(style || '');
  if (!text) return '';
  var found =
    kuma.regex.first("(?:background-image|--photoURL)\\s*:\\s*url\\(\\s*['\"]?([^'\")]+)", 'i', text) ||
    kuma.regex.first("url\\(\\s*['\"]?([^'\")]+)", 'i', text);
  if (!found) return '';
  return String(found).replace(/\s+/g, '');
}

/**
 * A listing row's cover.
 *
 * The latest-updates card puts the background on the anchor itself; the
 * catalogue card puts it on a div inside. Both are tried, and the first style
 * that yields a URL wins.
 *
 * The URL found is an image-proxy address (`wsrv.nl/?url=cdn.meowing.org/…&w=600`
 * or `i0.wp.com/cdn.meowing.org/…?w=300`) and is deliberately kept as-is.
 * Rewriting it to the CDN original would work and would download 4.7 MB of
 * artwork to fill a thumbnail.
 */
function coverFrom(anchor) {
  var own = urlFromStyle(anchor.attr('style'));
  if (own) return own;

  var styled = anchor.select(SELECTORS.styled);
  for (var i = 0; i < styled.length; i++) {
    var url = urlFromStyle(styled[i].attr('style'));
    if (url) return url;
  }
  return '';
}

/**
 * The clean title for a row.
 *
 * `alt` and `title` on the anchor agree and hold the English title alone. The
 * enclosing `<button>` also has a `title`, but it has the alternative titles
 * (or, on some sites, the genre list) concatenated onto the end — reading that
 * one gives every result a plausible, wrong name.
 */
function titleFrom(anchor) {
  var title = anchor.attr('title') || anchor.attr('alt');
  return String(title || '').replace(/\s+/g, ' ').trim();
}

// MARK: - Listings

/**
 * Reads any grid of series cards into manga rows.
 *
 * Keyed by series id and merged, because one card links the series twice: the
 * cover anchor carries the artwork and the heading anchor carries nothing but
 * the name. One row per anchor would double every listing and leave half the
 * rows with no cover.
 */
function parseListing(html) {
  var anchors = kuma.html.parse(html).select(SELECTORS.seriesLink);
  var byId = {};
  var order = [];

  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i];
    var id = seriesIdFrom(anchor.attr('href'));
    if (!id) continue;

    if (!byId[id]) {
      byId[id] = { url: '/series/' + id + '/', title: '', thumbnailUrl: '' };
      order.push(id);
    }
    var row = byId[id];
    if (!row.title) row.title = titleFrom(anchor);
    if (!row.thumbnailUrl) row.thumbnailUrl = coverFrom(anchor);
  }

  var out = [];
  for (var j = 0; j < order.length; j++) {
    var entry = byId[order[j]];
    if (!entry.title) continue;
    out.push({
      url: entry.url,
      title: entry.title,
      thumbnailUrl: entry.thumbnailUrl,
      status: 'Unknown'
    });
  }
  return out;
}

/**
 * One response, remembered briefly.
 *
 * Every listing here is the site's entire catalogue in a single response — up
 * to 1.5 MB — and paging is done locally, so without this, scrolling a shelf
 * would re-download the whole thing per screen. One entry, and short enough
 * that a refresh a minute later sees new chapters.
 */
var LISTING_CACHE = { url: '', html: '', at: 0 };
var LISTING_CACHE_MS = 60000;

function fetchListing(url) {
  var now = Date.now();
  if (LISTING_CACHE.url === url && now - LISTING_CACHE.at < LISTING_CACHE_MS) {
    return LISTING_CACHE.html;
  }
  var html = kuma.http.get(url);
  LISTING_CACHE = { url: url, html: html, at: now };
  return html;
}

/**
 * The whole catalogue.
 *
 * `/search_series` is the fragment the site's own search box loads: every
 * series, one card each, without the surrounding page. `/series/` renders the
 * same cards inside another 100 KB of chrome and `parseListing` reads it just
 * as well, so it is the fallback — if the fragment endpoint is ever renamed,
 * eight sources degrade to a heavier request rather than to empty shelves.
 */
function catalogue() {
  var rows = parseListing(fetchListing(kuma.baseUrl + '/search_series'));
  if (rows.length) return rows;
  return parseListing(fetchListing(kuma.baseUrl + '/series/'));
}

function pageOf(rows, page) {
  var n = parseInt(page, 10);
  if (isNaN(n) || n < 1) n = 1;
  var start = (n - 1) * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
}

// MARK: - Dates

var MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

var RELATIVE_MS = {
  second: 1000,
  minute: 60000,
  hour: 3600000,
  day: 86400000,
  week: 604800000,
  month: 2592000000,
  year: 31536000000
};

/**
 * The `d` attribute on a chapter row, as a timestamp.
 *
 * Keyoapp writes recent chapters as "3 hours ago" and older ones as
 * "Sep 3, 2026". `Date.parse` handles the second spelling on most engines and
 * none of the first, and "most engines" is not a promise worth relying on in
 * JavaScriptCore — so both are parsed here, and anything unrecognised returns
 * null rather than an Invalid Date that reads as 1970 in the chapter list.
 */
function parseDate(text, now) {
  var value = String(text || '').trim();
  if (!value) return null;

  var relative = /^(\d+)\s*(second|minute|hour|day|week|month|year)s?\s+ago$/i.exec(value);
  if (relative) {
    var unit = RELATIVE_MS[relative[2].toLowerCase()];
    if (!unit) return null;
    return (now || Date.now()) - parseInt(relative[1], 10) * unit;
  }

  var absolute = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(value);
  if (absolute) {
    var month = MONTHS[absolute[1].toLowerCase()];
    if (month === undefined) return null;
    return Date.UTC(parseInt(absolute[3], 10), month, parseInt(absolute[2], 10));
  }
  return null;
}

// Site vocabulary onto SMangaStatus raw values.
function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('ongoing') >= 0) return 'Ongoing';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  if (text.indexOf('complete') >= 0) return 'Completed';
  return 'Unknown';
}

// MARK: - Source

var KumaSource = {
  fetchPopular: function (page) {
    return pageOf(catalogue(), page);
  },

  fetchLatest: function (page) {
    return pageOf(parseListing(fetchListing(kuma.baseUrl + '/latest/')), page);
  },

  // Client-side, because the site is: it ships the whole catalogue and filters
  // it in the browser. There is no search endpoint to call.
  fetchSearch: function (text, page) {
    var rows = catalogue();
    var needle = String(text || '').toLowerCase().trim();
    if (!needle) return pageOf(rows, page);

    var hits = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].title.toLowerCase().indexOf(needle) >= 0) hits.push(rows[i]);
    }
    return pageOf(hits, page);
  },

  getMangaDetails: function (url) {
    var id = seriesIdFrom(url) || String(url || '').replace(/^\/+/, '');
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/series/' + id + '/'));

    var details = { url: '/series/' + id + '/', status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) details.title = heading.text();

    var summary = doc.selectFirst(SELECTORS.detailDescription);
    if (summary) details.description = summary.text();

    // Specifically the --photoURL div. The page also draws a blurred backdrop
    // from a 3-pixel-wide copy of the same artwork, and it comes first in the
    // markup, so "the first element with a background image" is the wrong one.
    var cover = doc.selectFirst(SELECTORS.detailCover);
    if (cover) details.thumbnailUrl = urlFromStyle(cover.attr('style'));

    var status = doc.selectFirst(SELECTORS.detailStatus);
    if (status) details.status = statusOf(status.text());

    // Genres are the chips linking back into the catalogue's own filter. There
    // is no author or artist anywhere on a Keyoapp series page.
    var genres = doc.select(SELECTORS.detailGenre);
    for (var i = 0; i < genres.length; i++) {
      var name = titleFrom(genres[i]) || genres[i].text();
      if (name) details.genres.push(name);
    }
    return details;
  },

  getChapterList: function (url) {
    var id = seriesIdFrom(url) || String(url || '').replace(/^\/+/, '');
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/series/' + id + '/'));
    var rows = doc.select(SELECTORS.chapterRow);
    var now = Date.now();

    var out = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var chapterId = chapterIdFrom(row.attr('href'));
      if (!chapterId || seen[chapterId]) continue;

      // Dropped rather than listed: a paid chapter's reader page contains no
      // #pages element at all, so listing it would offer the reader a chapter
      // that opens to nothing.
      if (row.selectFirst(SELECTORS.lockIcon)) continue;
      seen[chapterId] = true;

      var name = titleFrom(row);
      out.push({
        url: '/chapter/' + chapterId + '/',
        name: name || 'Chapter',
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        dateUpload: parseDate(row.attr('d'), now)
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var id = chapterIdFrom(chapterUrl) || String(chapterUrl || '').replace(/^\/+/, '');
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/chapter/' + id + '/'));
    var images = doc.select(SELECTORS.pageImage);

    var out = [];
    for (var i = 0; i < images.length; i++) {
      // Only the uid. `src` is a placeholder graphic on every single page, and
      // it loads — a source that read it would return a full, working chapter
      // of identical grey rectangles.
      var uid = String(images[i].attr('uid') || '').trim();
      if (!uid || uid.indexOf('placeholder') >= 0) continue;
      out.push({ url: PAGE_CDN + uid });
    }
    return out;
  }
};
