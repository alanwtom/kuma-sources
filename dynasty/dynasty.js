/*
 * Dynasty Scans — Kuma JavaScript source.
 *
 * A yuri and doujinshi scanlation site. Small and old-fashioned, which makes
 * it one of the easier scrapes: server-rendered HTML throughout, and the
 * reader embeds its page list as plain JSON rather than obfuscating it.
 *
 * The one structural oddity is browsing: `/series` returns the *entire*
 * catalogue on a single page, with no paging at all. Pages are therefore cut
 * from that one response rather than fetched, and the response is parsed once
 * and reused — see `catalogue()`.
 */

var PAGE_SIZE = 30;

var SELECTORS = {
  seriesLink: "a[href^='/series/']",
  detailTitle: 'h2.tag-title',
  detailTags: 'div.tag-tags',
  detailCover: 'div.cover',
  detailDescription: 'div.description',
  chapterList: 'dl.chapter-list',
  chapterRow: 'dd',
  chapterLink: 'a.name',
  chapterReleased: 'small'
};

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

function slugFrom(url) {
  return kuma.regex.first('/series/([^/?#]+)', '', String(url || ''))
    || String(url || '').replace(/^\/+/, '');
}

function parseSeriesLinks(html) {
  var anchors = kuma.html.parse(html).select(SELECTORS.seriesLink);
  var out = [];
  var seen = {};

  for (var i = 0; i < anchors.length; i++) {
    var slug = slugFrom(anchors[i].attr('href'));
    var title = anchors[i].text();
    if (!slug || !title || seen[slug]) continue;
    seen[slug] = true;
    out.push({ url: '/series/' + slug, title: title, thumbnailUrl: '', status: 'Unknown' });
  }
  return out;
}

// The whole catalogue arrives in one response, so it is fetched once and cut
// into pages. Re-fetching per page would mean pulling the entire list again
// for every scroll.
var catalogueCache = null;

function catalogue() {
  if (!catalogueCache) catalogueCache = parseSeriesLinks(kuma.http.get(kuma.baseUrl + '/series'));
  return catalogueCache;
}

// "released Oct 6 '19" — a two-digit year with an apostrophe, which nothing
// parses natively.
function releasedAt(text) {
  var value = String(text || '');
  var match = new RegExp("([A-Z][a-z]{2})\\s+(\\d{1,2})\\s*'(\\d{2})").exec(value);
  if (!match) return null;
  var parsed = Date.parse(match[1] + ' ' + match[2] + ', 20' + match[3] + ' UTC');
  return isNaN(parsed) ? null : parsed;
}

var KumaSource = {
  // The site publishes no ranking, so browse is its own catalogue order.
  fetchPopular: function (page) {
    var all = catalogue();
    var start = (pageNumber(page) - 1) * PAGE_SIZE;
    return all.slice(start, start + PAGE_SIZE);
  },

  // No separate recent-series feed; the catalogue is the only listing.
  fetchLatest: function (page) {
    return KumaSource.fetchPopular(page);
  },

  fetchSearch: function (text, page) {
    if (pageNumber(page) > 1) return [];
    return parseSeriesLinks(kuma.http.get(
      kuma.baseUrl + '/search?q=' + encodeURIComponent(text) + '&classes%5B%5D=Series'
    ));
  },

  getMangaDetails: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/series/' + slug));
    var details = { url: '/series/' + slug, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) {
      // "<b>Title</b> by <a>Author</a>, <a>Artist</a>" — the bold part is the
      // title, the links are the people.
      var bold = heading.selectFirst('b');
      if (bold) details.title = bold.text();
      var people = heading.select('a');
      if (people.length) details.author = people[0].text();
      if (people.length > 1) details.artist = people[1].text();
    }

    var tags = doc.selectFirst(SELECTORS.detailTags);
    if (tags) {
      var labels = tags.select('a');
      for (var i = 0; i < labels.length; i++) {
        var tag = labels[i].text();
        if (tag) details.genres.push(tag);
      }
    }

    var coverBox = doc.selectFirst(SELECTORS.detailCover);
    var cover = coverBox ? coverBox.selectFirst('img') : null;
    if (cover) details.thumbnailUrl = cover.absAttr('src');

    var summary = doc.selectFirst(SELECTORS.detailDescription);
    if (summary) details.description = summary.text();

    return details;
  },

  getChapterList: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/series/' + slug));
    var box = doc.selectFirst(SELECTORS.chapterList);
    if (!box) return [];

    var rows = box.select(SELECTORS.chapterRow);
    var out = [];
    var seen = {};

    for (var i = 0; i < rows.length; i++) {
      // `a.name` specifically: the row also links every tag on the chapter,
      // and the page header links elsewhere in the site.
      var link = rows[i].selectFirst(SELECTORS.chapterLink);
      if (!link) continue;
      var href = String(link.attr('href') || '');
      if (!href || seen[href]) continue;
      seen[href] = true;

      var released = rows[i].selectFirst(SELECTORS.chapterReleased);
      var name = link.text();
      out.push({
        url: href.charAt(0) === '/' ? href : '/' + href,
        name: name || href,
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        dateUpload: released ? releasedAt(released.text()) : null
      });
    }
    // Listed oldest first; the reader expects newest at the top.
    out.reverse();
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.charAt(0) !== '/') path = '/' + path;
    var body = kuma.http.get(kuma.baseUrl + path);

    // The reader ships its page list as JSON in a script tag rather than as
    // markup, so this is the one place regex beats the parser.
    var raw = kuma.regex.first('var\\s+pages\\s*=\\s*(\\[[\\s\\S]*?\\]);', '', body);
    if (!raw) return [];

    var pages;
    try {
      pages = JSON.parse(raw);
    } catch (e) {
      return [];
    }

    var out = [];
    for (var i = 0; i < (pages || []).length; i++) {
      var image = pages[i] && pages[i].image;
      if (image) out.push({ url: kuma.absoluteUrl(image) });
    }
    return out;
  }
};
