/*
 * MangaRead — Kuma JavaScript source.
 *
 * The site runs Madara, a WordPress theme used by a large family of manga
 * sites, so the selectors here are the theme's rather than this site's. That
 * is the point: porting this to another Madara site is mostly changing
 * `baseUrl`. Anything genuinely site-specific is called out below.
 *
 * Two Madara quirks worth knowing before editing:
 *  - **Chapters come from a POST**, not the series page. The page does embed
 *    them, but it is 1.5 MB of mostly navigation; `/ajax/chapters/` returns
 *    the same list on its own.
 *  - **Image URLs are padded with whitespace.** Madara emits
 *    `src="\n\t\thttps://…"`, so every extracted address has to be trimmed or
 *    every page fails to load.
 */

// The site serves 12 rows a page, and the host treats a page of fewer than 20
// as the end of the list. Two site pages therefore make one Kuma page, or
// browsing stops dead after the first screen.
var SITE_ROWS_PER_PAGE = 12;

var SELECTORS = {
  // Browse and search use different wrappers for the same kind of row.
  listingRow: 'div.page-item-detail, div.row.c-tabs-item__content',
  listingLink: "a[href*='/manga/']",
  listingTitle: 'h3',
  cover: 'img',
  detailTitle: 'div.post-title',
  detailCover: 'div.summary_image',
  detailSummary: 'div.summary__content',
  detailGenres: 'div.genres-content',
  detailItem: 'div.post-content_item',
  detailItemLabel: 'div.summary-heading',
  detailItemValue: 'div.summary-content',
  chapterRow: 'li.wp-manga-chapter',
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

function slugFrom(url) {
  return kuma.regex.first('/manga/([^/?#]+)', '', String(url || ''))
    || String(url || '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/** Madara pads attribute values with newlines and tabs. */
function trimmed(value) {
  return String(value || '').replace(/^\s+|\s+$/g, '');
}

/**
 * Madara writes `src="\t\t\n\t\thttps://…"`, so the raw value must be trimmed
 * *before* it is resolved. Trimming afterwards is too late: the padded string
 * doesn't look absolute, gets the site prefixed onto it, and every page in
 * every chapter 404s while still looking like a list of images.
 */
function imageFrom(node) {
  if (!node) return '';
  // `data-src` first: Madara lazy-loads on some configurations and not others.
  var raw = trimmed(node.attr('data-src')) || trimmed(node.attr('src'));
  return raw ? kuma.absoluteUrl(raw) : '';
}

function parseListing(html) {
  var rows = kuma.html.parse(html).select(SELECTORS.listingRow);
  var out = [];
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var link = row.selectFirst(SELECTORS.listingLink);
    if (!link) continue;

    var slug = slugFrom(link.attr('href'));
    if (!slug || seen[slug]) continue;
    seen[slug] = true;

    // The heading holds the readable title; the cover anchor carries it only
    // as a `title` attribute, which some rows omit.
    var heading = row.selectFirst(SELECTORS.listingTitle);
    var title = heading ? heading.text() : '';
    if (!title) title = trimmed(link.attr('title'));
    if (!title) continue;

    out.push({
      url: '/manga/' + slug,
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
 * One Kuma page from two of the site's, deduplicated.
 *
 * `urlFor` takes a site page number. The second fetch is skipped when the
 * first came back empty, so running off the end of the catalogue costs one
 * request rather than two.
 */
function listingPage(urlFor, page) {
  var n = pageNumber(page);
  var first = parseListing(kuma.http.get(urlFor(n * 2 - 1)));
  if (!first.length) return [];

  var out = first.slice(0);
  var seen = {};
  for (var i = 0; i < out.length; i++) seen[out[i].url] = true;

  // The second fetch must not be able to fail the first. Some Madara sites
  // answer a past-the-end `/page/N/` with a 404 rather than an empty list,
  // and letting that propagate threw away a perfectly good page of results —
  // search returned "not found" on a site whose search worked.
  var second = [];
  var res = kuma.http.tryGet(urlFor(n * 2));
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

var KumaSource = {
  fetchPopular: function (page) {
    return listingPage(function (n) {
      return pagedPath('/manga/', n, '?m_orderby=views');
    }, page);
  },

  fetchLatest: function (page) {
    return listingPage(function (n) {
      return pagedPath('/manga/', n, '?m_orderby=latest');
    }, page);
  },

  fetchSearch: function (text, page) {
    var encoded = encodeURIComponent(text);
    return listingPage(function (n) {
      return pagedPath('/', n, '?s=' + encoded + '&post_type=wp-manga');
    }, page);
  },

  getMangaDetails: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/manga/' + slug + '/'));

    var details = { url: '/manga/' + slug, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) details.title = heading.text();

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

  getChapterList: function (url) {
    var slug = slugFrom(url);
    // POST, and the series page is not a fallback worth having: it carries
    // the same list inside 1.5 MB of navigation.
    var body = kuma.http.post(kuma.baseUrl + '/manga/' + slug + '/ajax/chapters/', '', {
      'X-Requested-With': 'XMLHttpRequest'
    });

    var rows = kuma.html.parse(body).select(SELECTORS.chapterRow);
    var out = [];
    var seen = {};

    for (var i = 0; i < rows.length; i++) {
      var link = rows[i].selectFirst('a');
      if (!link) continue;
      var href = trimmed(link.attr('href'));
      var id = kuma.regex.first('/manga/[^/]+/([^/?#]+)', '', href);
      if (!id || seen[id]) continue;
      seen[id] = true;

      var name = link.text();
      out.push({
        url: '/manga/' + slug + '/' + id,
        name: name || id,
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name || id)),
        dateUpload: dateFrom(rows[i].selectFirst(SELECTORS.chapterDate) ?
          rows[i].selectFirst(SELECTORS.chapterDate).text() : '')
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.charAt(0) !== '/') path = '/' + path;
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + path + '/'));

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
