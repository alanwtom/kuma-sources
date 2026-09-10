/*
 * Mangapill — Kuma JavaScript source.
 *
 * A scraped source, like Weeb Central, but the site is plain server-rendered
 * HTML rather than htmx fragments, so this reads whole pages.
 *
 * Three things about the site that shape the code:
 *  - **Images are lazy-loaded.** Covers and pages carry `data-src`, and `src`
 *    is empty. Reading `src` yields a source that finds every title and shows
 *    no artwork at all.
 *  - **A listing links each title twice** — once around the cover, once
 *    around the name — so rows are keyed by id and merged.
 *  - **Metadata is a label beside a value** with no class to grab, so it is
 *    read by finding the label and stepping up to its container.
 *
 * The site has no popularity ranking and no chapter dates, and this does not
 * invent either: browse is catalogue order, and chapters carry no date.
 */

// Fixed by the site: a search page returns 50 rows.
var PAGE_SIZE = 50;

var SELECTORS = {
  seriesLink: "a[href^='/manga/']",
  listTitle: '.line-clamp-2',
  cover: 'img',
  detailTitle: 'h1',
  detailDescription: 'p.text-sm',
  detailLabel: 'label',
  chapterLink: "a[href^='/chapters/']",
  pageImage: 'img.js-page'
};

// Covers and pages are lazy-loaded, so the real address is in `data-src`.
function imageFrom(node) {
  if (!node) return '';
  return node.absAttr('data-src') || node.absAttr('src');
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

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

function mangaIdFrom(href) {
  return kuma.regex.first('/manga/(\\d+)', '', String(href || ''));
}

function chapterPathFrom(href) {
  var match = kuma.regex.first('(/chapters/[^?#"]+)', '', String(href || ''));
  return match || String(href || '');
}

/** "one-piece" -> "One Piece". Only used when a row carries no title. */
function titleFromSlug(href) {
  var slug = kuma.regex.first('/manga/\\d+/([^/?#]+)', '', String(href || ''));
  if (!slug) return '';
  var words = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim().split(' ');
  var out = [];
  for (var i = 0; i < words.length; i++) {
    if (!words[i]) continue;
    out.push(words[i].charAt(0).toUpperCase() + words[i].slice(1));
  }
  return out.join(' ');
}

/**
 * Reads a listing page.
 *
 * Keyed by manga id: the cover anchor holds the artwork and the name anchor
 * holds the title, so taking one row per anchor both duplicates every result
 * and leaves half of them without a picture.
 */
function parseListing(html) {
  var anchors = kuma.html.parse(html).select(SELECTORS.seriesLink);
  var byId = {};
  var order = [];

  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i];
    var href = anchor.attr('href');
    var id = mangaIdFrom(href);
    if (!id) continue;

    if (!byId[id]) {
      byId[id] = { url: '/manga/' + id, title: '', thumbnailUrl: '', slug: titleFromSlug(href) };
      order.push(id);
    }
    var entry = byId[id];

    if (!entry.thumbnailUrl) entry.thumbnailUrl = imageFrom(anchor.selectFirst(SELECTORS.cover));
    if (!entry.title) {
      var label = anchor.selectFirst(SELECTORS.listTitle);
      if (label) entry.title = label.text();
    }
  }

  var out = [];
  for (var j = 0; j < order.length; j++) {
    var row = byId[order[j]];
    var title = row.title || row.slug;
    if (!title) continue;
    out.push({ url: row.url, title: title, thumbnailUrl: row.thumbnailUrl, status: 'Unknown' });
  }
  return out;
}

// The site's own words for state.
function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('publishing') >= 0 || text.indexOf('ongoing') >= 0) return 'Ongoing';
  if (text.indexOf('finished') >= 0 || text.indexOf('complete') >= 0) return 'Finished';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  return 'Unknown';
}

var KumaSource = {
  // No popularity ranking exists on the site, so this is catalogue order.
  // Inventing a ranking by, say, chapter count would be a worse lie than
  // simply browsing everything.
  fetchPopular: function (page) {
    return parseListing(kuma.http.get(
      kuma.baseUrl + '/search' + query([['type', 'manga'], ['status', ''], ['page', pageNumber(page)]])
    ));
  },

  // The recent-chapters feed is a single page on the site. Later pages return
  // nothing rather than re-serving the same rows as if they were new.
  fetchLatest: function (page) {
    if (pageNumber(page) > 1) return [];
    return parseListing(kuma.http.get(kuma.baseUrl + '/chapters'));
  },

  fetchSearch: function (text, page) {
    return parseListing(kuma.http.get(
      kuma.baseUrl + '/search' + query([['q', text], ['type', ''], ['status', ''], ['page', pageNumber(page)]])
    ));
  },

  getMangaDetails: function (url) {
    var id = mangaIdFrom(url) || String(url || '').replace(/^\/+/, '');
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/manga/' + id));

    var details = { url: '/manga/' + id, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) details.title = heading.text();

    var summary = doc.selectFirst(SELECTORS.detailDescription);
    if (summary) details.description = summary.text();

    details.thumbnailUrl = imageFrom(doc.selectFirst(SELECTORS.cover));

    // Each fact is "<label>Status</label><div>publishing</div>" with nothing
    // distinguishing the value. Find the label, step up to the container, and
    // take what is left — the only route without a sibling combinator.
    var labels = doc.select(SELECTORS.detailLabel);
    for (var i = 0; i < labels.length; i++) {
      var container = labels[i].parent();
      if (!container) continue;
      var name = labels[i].text().toLowerCase();
      var value = container.textExcluding(labels[i]);

      if (name.indexOf('status') === 0) {
        details.status = statusOf(value);
      } else if (name.indexOf('genre') === 0) {
        var genres = [];
        var links = container.select('a');
        for (var g = 0; g < links.length; g++) {
          var genre = links[g].text();
          if (genre) genres.push(genre);
        }
        if (genres.length) details.genres = genres;
      }
    }
    return details;
  },

  getChapterList: function (url) {
    var id = mangaIdFrom(url) || String(url || '').replace(/^\/+/, '');
    var anchors = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/manga/' + id))
      .select(SELECTORS.chapterLink);

    var out = [];
    var seen = {};
    for (var i = 0; i < anchors.length; i++) {
      var href = chapterPathFrom(anchors[i].attr('href'));
      if (!href || seen[href]) continue;
      seen[href] = true;

      var name = anchors[i].text() || 'Chapter';
      out.push({
        url: href,
        name: name,
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        // The site publishes no per-chapter date. Reporting "now" would put
        // a fresh timestamp on a twenty-year-old chapter.
        dateUpload: null
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = chapterPathFrom(chapterUrl);
    var images = kuma.html.parse(kuma.http.get(kuma.baseUrl + path)).select(SELECTORS.pageImage);

    var out = [];
    for (var i = 0; i < images.length; i++) {
      var src = imageFrom(images[i]);
      if (src) out.push({ url: src });
    }
    return out;
  }
};
