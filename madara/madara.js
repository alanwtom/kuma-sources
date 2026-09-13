/*
 * Madara / WP-Manga — Kuma engine source.
 *
 * Madara is a WordPress theme used by a large family of manga sites, so the
 * selectors here are the theme's rather than any one site's. That is the point:
 * adding another Madara site is a manifest entry, not a new file.
 *
 * ── What a manifest may set (`kuma.options`, all values are strings) ────────
 *
 *   seriesPath    URL prefix a series lives under. Default "/manga/".
 *                 Seen while probing: /series/ /webtoon/ /project/ /manhua/
 *                 /comic/ /m/ /title/. It was hardcoded in nine places, and a
 *                 site that uses anything else showed an empty shelf, silently.
 *   listPath      Browse listing path, when it differs from `seriesPath`.
 *                 Defaults to `seriesPath`. Two sites need this: hunlightcomics
 *                 browses at /manga/ and files series under /m/; topmanhua.fan
 *                 browses at /manga/ and files series under /manhua/. Guessing
 *                 one from the other gives a 404 listing and an empty shelf.
 *   popularOrder  `m_orderby` value for Popular. Default "views".
 *   latestOrder   `m_orderby` value for Latest.  Default "latest".
 *   rowsPerPage   How many rows the site puts on one page. Default "12".
 *                 The host reads a page of fewer than 20 as the end of the
 *                 list, so anything under 20 means two site pages per Kuma
 *                 page or browsing stops dead after the first screen.
 *   chapterSource Where the chapter list comes from: "ajax" (default),
 *                 "page", or "api". See getChapterList.
 *
 * There are deliberately **no selectors here**. `HTMLSelector` degrades
 * silently — an unknown pseudo-class is dropped and the selector then matches
 * everything — so a mistyped selector in a manifest would produce confidently
 * wrong results instead of an error. Markup variance is handled below by
 * trying one thing and falling back when it yields nothing.
 *
 * ── Madara quirks that cost real time, all of which fail silently ───────────
 *
 *  - **Chapters usually come from a POST**, not the series page. Some sites
 *    embed the list too, but manhwareads.com embeds *zero* — scraping the
 *    series page there shows a site with no chapters and no error.
 *  - **Image URLs are padded with whitespace.** Madara emits
 *    `src="\n\t\thttps://…"`, so every address must be trimmed *before* it is
 *    resolved, or it stops looking absolute, gets the site prefixed onto it,
 *    and the whole chapter 404s while still looking like a list of pages.
 *  - **`div.chapter-item` is the sidebar, not the chapter list.** The
 *    "latest updates" widget on the series page uses that class for *other*
 *    manga — kunmanga.online serves 24 of them for titles you didn't ask for.
 *    Matching it unscoped gives a chapter list belonging to a different comic.
 *    Everything below is therefore scoped to the list container, and series
 *    page chapters are additionally filtered to hrefs under this series.
 *  - **A heading's text is not its title.** kunmanga.online puts a "HOT" badge
 *    inside the same `h3`, so reading the heading gives "HOT Tales of Demons
 *    and Gods". Read the anchor inside the heading first.
 *  - **Never rebuild a URL the site already gave us.** Chapter links are
 *    `/manga/<slug>/<chapter>` on most sites, but reconstructing that shape
 *    assumes a prefix and a two-level layout, and both vary. Keep the href.
 */

/** Manifest options, with defaults that keep the original two sites unchanged. */
function option(name, fallback) {
  var all = (typeof kuma !== 'undefined' && kuma.options) ? kuma.options : null;
  var value = all ? all[name] : null;
  if (value === null || value === undefined) return fallback;
  value = String(value);
  return value === '' ? fallback : value;
}

function withSlashes(path) {
  var value = String(path || '');
  if (value.charAt(0) !== '/') value = '/' + value;
  if (value.charAt(value.length - 1) !== '/') value += '/';
  return value;
}

function seriesPath() { return withSlashes(option('seriesPath', '/manga/')); }
function listPath() { return withSlashes(option('listPath', seriesPath())); }

/** Rows the site serves per page; the host treats < 20 as the end of the list. */
function rowsPerPage() {
  var n = parseInt(option('rowsPerPage', '12'), 10);
  return (isNaN(n) || n < 1) ? 12 : n;
}

/** Two site pages per Kuma page while a page holds fewer than 20 rows. */
function sitePagesPerPage() {
  return rowsPerPage() >= 20 ? 1 : 2;
}

var SELECTORS = {
  // Browse and search use different wrappers for the same kind of row.
  listingRow: 'div.page-item-detail, div.row.c-tabs-item__content',
  listingTitle: 'div.post-title, h3, h4, h5',
  cover: 'img',
  detailTitle: 'div.post-title',
  detailCover: 'div.summary_image',
  detailSummary: 'div.summary__content',
  detailGenres: 'div.genres-content',
  detailItem: 'div.post-content_item',
  detailItemLabel: 'div.summary-heading',
  detailItemValue: 'div.summary-content',
  // The series page wraps its chapter list in one of these. Scoping to the
  // wrapper is what keeps the sidebar's "latest updates" out of the list.
  chapterWrap: 'div.listing-chapters_wrap, ul.version-chap, div.chapter-list, div.page-content-listing',
  // Same Madara class, two elements: most sites use `li`, topmanhua.fan uses
  // `div`. `chapter-item` is the fallback and is *only* trusted inside the
  // list container — see parseChapterRows.
  chapterRow: 'li.wp-manga-chapter, div.wp-manga-chapter',
  chapterRowAlt: 'li.chapter-item, div.chapter-item, li.main-chapter',
  chapterDate: 'span.chapter-release-date',
  // Some Madara sites class every page image, others emit a bare <img> inside
  // the reader container. Both are tried, specific first.
  pageImage: 'img.wp-manga-chapter-img',
  pageContainer: 'div.reading-content'
};

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

/** Madara pads attribute values with newlines and tabs. */
function trimmed(value) {
  return String(value || '').replace(/^\s+|\s+$/g, '');
}

/**
 * A site-relative path for an href, with no query, fragment or trailing slash.
 *
 * Everything the source hands back to Kuma goes through here, so a URL is only
 * ever *kept*, never rebuilt. Rebuilding assumes the site's prefix and its
 * two-level `/prefix/series/chapter` layout, and both of those vary.
 */
function pathFrom(href) {
  var value = trimmed(href);
  if (!value) return '';
  // A volume header on a nested chapter list is `href="javascript:void(0)"`,
  // and a stray `mailto:` or `#` would otherwise become a path.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:/i.test(value)) return '';
  if (value.charAt(0) === '#') return '';
  value = value.replace(/^https?:\/\/[^/]+/i, '');
  value = value.replace(/[?#].*$/, '');
  if (!value) return '';
  if (value.charAt(0) !== '/') value = '/' + value;
  return value.replace(/\/+$/, '') || '';
}

function slugFrom(url) {
  var path = pathFrom(url);
  if (!path) return '';
  var parts = path.split('/').filter(function (p) { return p.length > 0; });
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Madara writes `src="\t\t\n\t\thttps://…"`, so the raw value must be trimmed
 * *before* it is resolved. Trimming afterwards is too late: the padded string
 * doesn't look absolute, gets the site prefixed onto it, and every page in
 * every chapter 404s while still looking like a list of images.
 */
function imageFrom(node) {
  if (!node) return '';
  // `data-src` first: Madara lazy-loads on some configurations and not others,
  // and a lazy site leaves `src` holding a placeholder or nothing at all.
  var raw = trimmed(node.attr('data-src'))
    || trimmed(node.attr('data-lazy-src'))
    || trimmed(node.attr('data-cfsrc'))
    || trimmed(node.attr('src'));
  if (!raw) {
    // Last resort: the first candidate in a srcset.
    var set = trimmed(node.attr('data-srcset')) || trimmed(node.attr('srcset'));
    if (set) raw = trimmed(set.split(',')[0].split(/\s+/)[0]);
  }
  return raw ? kuma.absoluteUrl(raw) : '';
}

/**
 * The row's own anchor — the one pointing at the series, not at a chapter.
 *
 * A series URL is exactly one segment past the prefix; a chapter is two or
 * more. That distinction is load-bearing: mangatop.org points its *cover*
 * anchor at the newest chapter and only the title anchor at the series, so
 * taking the first matching link stored every row as a chapter URL. Browse
 * looked perfect and every title opened to an empty page.
 */
function rowLink(row) {
  var prefix = seriesPath();
  var anchors = row.select('a');
  var firstWithHref = null;
  var firstUnderPrefix = null;

  for (var i = 0; i < anchors.length; i++) {
    var path = pathFrom(anchors[i].attr('href'));
    if (!path) continue;
    if (!firstWithHref) firstWithHref = anchors[i];
    if (path.indexOf(prefix) !== 0 || path.length <= prefix.length) continue;
    if (!firstUnderPrefix) firstUnderPrefix = anchors[i];

    var rest = path.slice(prefix.length);
    if (rest.indexOf('/') < 0) return anchors[i];
  }
  return firstUnderPrefix || firstWithHref;
}

/**
 * The readable title.
 *
 * The heading holds it, but not alone — kunmanga.online puts a "HOT" badge in
 * the same `h3`, so the heading's text reads "HOT Tales of Demons and Gods".
 * The anchor inside the heading is the label; the heading is its container.
 */
function rowTitle(row, link) {
  var heading = row.selectFirst(SELECTORS.listingTitle);
  if (heading) {
    var inner = heading.selectFirst('a');
    var linked = inner ? trimmed(inner.text()) : '';
    if (linked) return linked;
    var whole = trimmed(heading.text());
    if (whole) return whole;
  }
  return link ? trimmed(link.attr('title')) : '';
}

/**
 * The series' own title on its page.
 *
 * Two traps, both of which produce a confident wrong answer:
 *  - `div.post-title` is used by the "you may also like" sidebar too, and on
 *    manhwaden.com that sidebar comes *first* in the document — reading the
 *    first match named a different comic entirely.
 *  - The box holds the badges as well as the heading, so its own text reads
 *    "SS Martial Peak" or "18+ Reincarnated Fighting Gamer".
 *
 * The series heading is an `h1`/`h2`/`h3`; sidebar entries use `h4`/`h5`. So
 * the right box is the first one containing a real heading, and the title is
 * that heading's text rather than the box's.
 */
function detailTitle(doc) {
  var boxes = doc.select(SELECTORS.detailTitle);
  for (var i = 0; i < boxes.length; i++) {
    var heading = boxes[i].selectFirst('h1, h2, h3');
    if (heading) {
      var text = trimmed(heading.text());
      if (text) return text;
    }
  }
  // Sites with no `post-title` at all still put the title in the page's only
  // `h1`, which is more reliable than falling back to a badge-padded box.
  var lone = doc.selectFirst('h1');
  if (lone) {
    var only = trimmed(lone.text());
    if (only) return only;
  }
  return boxes.length ? trimmed(boxes[0].text()) : '';
}

function parseListing(html) {
  var rows = kuma.html.parse(html).select(SELECTORS.listingRow);
  var out = [];
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var link = rowLink(row);
    if (!link) continue;

    // Keep the site's own URL. A listing links the same title twice (cover
    // anchor, title anchor), so rows are keyed by that path and merged — one
    // row per anchor duplicates every result and leaves half of them untitled.
    var path = pathFrom(link.attr('href'));
    if (!path || seen[path]) continue;

    var title = rowTitle(row, link);
    if (!title) continue;
    seen[path] = true;

    out.push({
      url: path,
      title: title,
      thumbnailUrl: imageFrom(row.selectFirst(SELECTORS.cover)),
      status: 'Unknown'
    });
  }
  return out;
}

function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('ongoing') >= 0) return 'Ongoing';
  if (text.indexOf('completed') >= 0 || text.indexOf('complete') >= 0) return 'Completed';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  if (text.indexOf('canceled') >= 0 || text.indexOf('cancelled') >= 0) return 'Unknown';
  return 'Unknown';
}

// Madara writes dates as "16.01.2026", and "x hours ago" for recent ones.
function dateFrom(text) {
  var value = trimmed(text);
  if (!value) return null;

  var dotted = kuma.regex.first('^(\\d{2})\\.(\\d{2})\\.(\\d{4})$', '', value);
  if (dotted) {
    var parts = value.split('.');
    var parsed = Date.UTC(parseInt(parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    return isNaN(parsed) ? null : parsed;
  }
  // "3 days ago" and friends: relative, so anchored to now.
  var ago = new RegExp('^(\\d+)\\s+(hour|day|week|month|year)s?\\s+ago', 'i').exec(value);
  if (ago) {
    var amount = parseInt(ago[1], 10);
    var unit = ago[2].toLowerCase();
    var ms = { hour: 3600e3, day: 86400e3, week: 604800e3, month: 2592000e3, year: 31536000e3 }[unit];
    return Date.now() - amount * ms;
  }
  var direct = Date.parse(value);
  return isNaN(direct) ? null : direct;
}

/**
 * One Kuma page from one or two of the site's, deduplicated.
 *
 * `urlFor` takes a site page number. A second fetch is only made when the site
 * serves fewer than 20 rows a page, and is skipped when the first came back
 * empty, so running off the end of the catalogue costs one request not two.
 */
function listingPage(urlFor, page) {
  var n = pageNumber(page);
  var span = sitePagesPerPage();
  var first = parseListing(kuma.http.get(urlFor((n - 1) * span + 1)));
  if (!first.length || span === 1) return first;

  var out = first.slice(0);
  var seen = {};
  for (var i = 0; i < out.length; i++) seen[out[i].url] = true;

  // The second fetch must not be able to fail the first. Some Madara sites
  // answer a past-the-end `/page/N/` with a 404 rather than an empty list,
  // and letting that propagate threw away a perfectly good page of results —
  // search returned "not found" on a site whose search worked.
  var second = [];
  var res = kuma.http.tryGet(urlFor((n - 1) * span + 2));
  if (res.ok) second = parseListing(res.body);

  for (var j = 0; j < second.length; j++) {
    if (seen[second[j].url]) continue;
    out.push(second[j]);
  }
  return out;
}

/**
 * WordPress paths for page N.
 *
 * Page one is the bare path, not `/page/1/`. Some Madara sites serve both;
 * others answer `/page/1/` with a 404, which makes browse and search look
 * broken on those sites while working everywhere else.
 */
function pagedPath(prefix, n, query) {
  var base = kuma.baseUrl + prefix;
  if (n > 1) base += 'page/' + n + '/';
  return base + query;
}

/** The series page, fetched from a stored or freshly-scraped URL. */
function seriesUrl(url) {
  var path = pathFrom(url);
  if (!path) path = seriesPath() + slugFrom(url);
  return kuma.baseUrl + path + '/';
}

/**
 * Chapter rows out of a fragment, scoped twice so the sidebar cannot leak in.
 *
 * `scopeTo` is the series' own path, and **every** caller passes it. The
 * "latest updates" widget uses the same row classes for *other* comics — 24 of
 * them on kunmanga.online — so a chapter that does not live under this series
 * is somebody else's, and handing those back is worse than handing back none.
 *
 * The AJAX response needs this as much as the series page does: a site that
 * has moved its chapter list can answer that route with a whole 200 page of
 * markup rather than a 404 (mangadrama.com serves 132 KB that way).
 */
function parseChapterRows(html, scopeTo) {
  var doc = kuma.html.parse(html);

  // Prefer the list container when there is one — on a series page it is the
  // difference between this comic's chapters and the sidebar's. The AJAX
  // response usually has no wrapper, and then the whole fragment is the list.
  var wrap = doc.selectFirst(SELECTORS.chapterWrap);
  var scope = wrap || doc;

  var rows = scope.select(SELECTORS.chapterRow);
  if (!rows.length) rows = scope.select(SELECTORS.chapterRowAlt);
  if (!rows.length) return [];

  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i++) {
    var link = rows[i].selectFirst('a');
    if (!link) continue;
    var href = trimmed(link.attr('href'));
    // A truly relative href ("chapter-12") belongs under this series.
    if (href && href.charAt(0) !== '/' && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      href = scopeTo + '/' + href;
    }
    var path = pathFrom(href);
    if (!path || seen[path]) continue;
    if (path.indexOf(scopeTo + '/') !== 0) continue;
    seen[path] = true;

    // A row's own text is not its label: it carries release dates and icons
    // too. The anchor is the label.
    var name = trimmed(link.text());
    var dateNode = rows[i].selectFirst(SELECTORS.chapterDate);
    out.push({
      url: path,
      name: name || slugFrom(path),
      chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name || path)),
      dateUpload: dateFrom(dateNode ? dateNode.text() : '')
    });
  }
  return out;
}

/** The API hands back 100 rows a page and ignores a larger `per_page`. */
var API_PAGE_SIZE = 100;
/**
 * 30 pages is 3,000 chapters. The longest title found while probing reported
 * 2,130, so this clears the real catalogue and still bounds a runaway answer.
 */
var API_PAGE_LIMIT = 30;

/**
 * Chapters from the JSON endpoint some Madara skins moved them to.
 *
 * kunmanga.online serves an empty "Loading chapters…" placeholder in the
 * markup and fetches the real list from an address written into the page as
 * `getChaptersUrl`. Both AJAX endpoints 404 there, so a template without this
 * shows the site as having no chapters at all.
 *
 * **It paginates, and the default page is ten rows.** Reading only the first
 * response gives the newest ten chapters of a nine-hundred-chapter comic and
 * looks entirely healthy, so the pages are walked to `last_page`.
 */
function chaptersFromApi(seriesBody, basePath) {
  var endpoint = kuma.regex.first("getChaptersUrl\\s*=\\s*['\"]([^'\"]+)['\"]", '', String(seriesBody || ''));
  if (!endpoint) return [];

  var joiner = endpoint.indexOf('?') >= 0 ? '&' : '?';
  var out = [];
  var seen = {};

  for (var page = 1; page <= API_PAGE_LIMIT; page++) {
    var res = kuma.http.tryGet(endpoint + joiner + 'per_page=' + API_PAGE_SIZE + '&page=' + page);
    if (!res.ok) break;

    var payload;
    try { payload = JSON.parse(res.body); } catch (e) { break; }
    var data = payload && payload.data;
    var list = data && data.chapters;
    if (!list || !list.length) break;

    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      var slug = trimmed(row.chapter_slug);
      if (!slug || seen[slug]) continue;
      seen[slug] = true;

      var name = trimmed(row.chapter_name) || slug;
      var number = parseFloat(row.chapter_num);
      if (isNaN(number)) number = parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name));
      out.push({
        url: basePath + '/' + slug,
        name: name,
        chapterNumber: number,
        dateUpload: dateFrom(row.updated_at)
      });
    }

    var last = parseInt(data.last_page, 10);
    if (isNaN(last) || page >= last) break;
  }
  return out;
}

var KumaSource = {
  fetchPopular: function (page) {
    var order = option('popularOrder', 'views');
    return listingPage(function (n) {
      return pagedPath(listPath(), n, '?m_orderby=' + order);
    }, page);
  },

  fetchLatest: function (page) {
    var order = option('latestOrder', 'latest');
    return listingPage(function (n) {
      return pagedPath(listPath(), n, '?m_orderby=' + order);
    }, page);
  },

  fetchSearch: function (text, page) {
    var encoded = encodeURIComponent(text);
    return listingPage(function (n) {
      return pagedPath('/', n, '?s=' + encoded + '&post_type=wp-manga');
    }, page);
  },

  getMangaDetails: function (url) {
    var path = pathFrom(url) || (seriesPath() + slugFrom(url));
    var doc = kuma.html.parse(kuma.http.get(seriesUrl(url)));

    var details = { url: path, status: 'Unknown', genres: [] };

    details.title = detailTitle(doc);

    var summary = doc.selectFirst(SELECTORS.detailSummary);
    if (summary) details.description = summary.text();

    var coverBox = doc.selectFirst(SELECTORS.detailCover);
    details.thumbnailUrl = imageFrom(coverBox ? coverBox.selectFirst(SELECTORS.cover) : null);

    var genreBox = doc.selectFirst(SELECTORS.detailGenres);
    if (genreBox) {
      var links = genreBox.select('a');
      for (var g = 0; g < links.length; g++) {
        var genre = links[g].text();
        if (genre) details.genres.push(genre);
      }
    }

    // Facts are label/value pairs with no class naming the field, so they are
    // matched on the label text.
    var items = doc.select(SELECTORS.detailItem);
    for (var i = 0; i < items.length; i++) {
      var label = items[i].selectFirst(SELECTORS.detailItemLabel);
      var value = items[i].selectFirst(SELECTORS.detailItemValue);
      if (!label || !value) continue;
      var name = label.text().toLowerCase();

      if (name.indexOf('status') >= 0) details.status = statusOf(value.text());
      else if (name.indexOf('author') >= 0) details.author = value.text();
      else if (name.indexOf('artist') >= 0) details.artist = value.text();
    }
    return details;
  },

  /**
   * Where the chapter list comes from, in manifest order:
   *
   *   "ajax" (default) — POST `{series}/ajax/chapters/`, which returns the
   *      list on its own. Falls back to the series page if that 404s or comes
   *      back empty, because a site can move without warning.
   *   "page" — the series page carries the list and the AJAX route 404s
   *      (topmanhua.fan). Asking for the AJAX route first would cost every
   *      open on that site a wasted request.
   *   "api" — a JSON endpoint named in the page (kunmanga.online).
   */
  getChapterList: function (url) {
    var basePath = pathFrom(url) || (seriesPath() + slugFrom(url));
    var mode = option('chapterSource', 'ajax');

    if (mode === 'ajax') {
      // POST, and the series page is not a fallback worth having by default:
      // it carries the same list inside 1.5 MB of navigation, and on some
      // sites (manhwareads.com) it carries none of it at all.
      // `request` rather than `post`: a site that has moved its chapter list
      // answers this with a 404, and a throw there would take the whole screen
      // down instead of falling through to the series page.
      var res = kuma.http.request('POST', kuma.baseUrl + basePath + '/ajax/chapters/', '', {
        'X-Requested-With': 'XMLHttpRequest'
      });
      if (res.ok) {
        var rows = parseChapterRows(res.body, basePath);
        if (rows.length) return rows;
      }
    }

    var body = kuma.http.get(seriesUrl(url));
    if (mode === 'api') return chaptersFromApi(body, basePath);
    return parseChapterRows(body, basePath);
  },

  getPageList: function (chapterUrl) {
    var path = pathFrom(chapterUrl);
    if (!path) return [];
    // `?style=list` is Madara's "all pages on one screen" reader. Sites left
    // in paged mode serve exactly one image without it — decadencescans gives
    // 1 page plain and 25 with it — and every site that is already in list
    // mode ignores the parameter, so it is always sent.
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + path + '/?style=list'));

    // Classed images are unambiguous. Falling back to every image inside the
    // reader container catches the sites that don't class them, at the cost
    // of having to filter out the site's own furniture.
    var images = doc.select(SELECTORS.pageImage);
    if (!images.length) {
      var container = doc.selectFirst(SELECTORS.pageContainer);
      images = container ? container.select('img') : [];
    }

    var out = [];
    var seen = {};
    for (var i = 0; i < images.length; i++) {
      var src = imageFrom(images[i]);
      // A logo or spacer sitting in the container is not a page. Anything
      // served from the site's own theme directory is furniture.
      if (!src || seen[src]) continue;
      if (src.indexOf('/themes/') >= 0 || /logo|placeholder|loading|spacer/i.test(src)) continue;
      seen[src] = true;
      out.push({ url: src });
    }
    return out;
  }
};
