/*
 * MangaKatana — Kuma JavaScript source.
 *
 * Server-rendered HTML, with one wrinkle: the reader keeps its page list in a
 * JavaScript array whose **variable name changes** between pages. Matching on
 * that name would work once and then quietly return nothing, so the pages are
 * found by their image host instead, which is distinct from every other URL
 * on the page.
 *
 * The other trap is the listing heading, which reads
 * `"Some Title - Update chapter 2"` — the update note is a sibling of the
 * link, so the anchor's text is the title and the heading's is not.
 */

var SELECTORS = {
  listingRow: 'div#book_list div.item',
  listingLink: "a[href*='/manga/']",
  listingTitle: 'h3.title',
  cover: 'img',
  status: 'div.status',
  detailTitle: 'h1',
  detailSummary: 'div.summary',
  metaRow: 'ul.meta li',
  metaLabel: 'div.label',
  metaValue: 'div.value',
  chapterRow: 'div.chapters table tr',
  chapterLink: "a[href*='/manga/']",
  chapterDate: 'div.update_time'
};

// The reader's images all come from a numbered subdomain; nothing else on the
// page does.
var PAGE_URL = 'https://i\\d+\\.mangakatana\\.com/[^"\'\\s,\\]]+';

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

/** "aishiteru-uso-dakedo.10797" — slug and id together. */
function slugFrom(url) {
  return kuma.regex.first('/manga/([^/?#]+)', '', String(url || ''))
    || String(url || '').replace(/^\/+/, '');
}

function statusOf(text) {
  var value = String(text || '').toLowerCase();
  if (value.indexOf('ongoing') >= 0) return 'Ongoing';
  if (value.indexOf('completed') >= 0) return 'Completed';
  if (value.indexOf('cancel') >= 0 || value.indexOf('hiatus') >= 0) return 'Unknown';
  return 'Unknown';
}

function parseListing(html) {
  var rows = kuma.html.parse(html).select(SELECTORS.listingRow);
  var out = [];
  var seen = {};

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var heading = row.selectFirst(SELECTORS.listingTitle);
    // The anchor, not the heading: the heading also holds a
    // "- Update chapter 2" note that would end up in every title.
    var link = heading ? heading.selectFirst('a') : row.selectFirst(SELECTORS.listingLink);
    if (!link) continue;

    var slug = slugFrom(link.attr('href'));
    var title = link.text();
    if (!slug || !title || seen[slug]) continue;
    seen[slug] = true;

    var status = row.selectFirst(SELECTORS.status);
    out.push({
      url: '/manga/' + slug,
      title: title,
      thumbnailUrl: (function () {
        var image = row.selectFirst(SELECTORS.cover);
        return image ? image.absAttr('src') : '';
      })(),
      status: status ? statusOf(status.text()) : 'Unknown'
    });
  }
  return out;
}

var KumaSource = {
  fetchPopular: function (page) {
    return parseListing(kuma.http.get(kuma.baseUrl + '/manga/page/' + pageNumber(page)));
  },

  fetchLatest: function (page) {
    return parseListing(kuma.http.get(kuma.baseUrl + '/latest/page/' + pageNumber(page)));
  },

  fetchSearch: function (text, page) {
    return parseListing(kuma.http.get(
      kuma.baseUrl + '/page/' + pageNumber(page)
      + '?search=' + encodeURIComponent(text) + '&search_by=book_name'
    ));
  },

  getMangaDetails: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/manga/' + slug));
    var details = { url: '/manga/' + slug, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) details.title = heading.text();

    var summary = doc.selectFirst(SELECTORS.detailSummary);
    if (summary) details.description = summary.text();

    var cover = doc.selectFirst('div.cover ' + SELECTORS.cover) || doc.selectFirst(SELECTORS.cover);
    if (cover) details.thumbnailUrl = cover.absAttr('src');

    // Label/value rows with no class naming the field, so matched on wording.
    var rows = doc.select(SELECTORS.metaRow);
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].selectFirst(SELECTORS.metaLabel);
      var value = rows[i].selectFirst(SELECTORS.metaValue);
      if (!label || !value) continue;
      var name = label.text().toLowerCase();

      if (name.indexOf('author') >= 0) {
        details.author = value.text();
      } else if (name.indexOf('genre') >= 0) {
        var links = value.select('a');
        for (var g = 0; g < links.length; g++) {
          var genre = links[g].text();
          if (genre) details.genres.push(genre);
        }
      } else if (name.indexOf('status') >= 0) {
        details.status = statusOf(value.text());
      }
    }
    return details;
  },

  getChapterList: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/manga/' + slug));
    var rows = doc.select(SELECTORS.chapterRow);

    var out = [];
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var link = rows[i].selectFirst(SELECTORS.chapterLink);
      if (!link) continue;
      var href = String(link.attr('href') || '');
      var path = kuma.regex.first('(/manga/[^?#]+)', '', href);
      if (!path || path === '/manga/' + slug || seen[path]) continue;
      seen[path] = true;

      var when = rows[i].selectFirst(SELECTORS.chapterDate);
      var parsed = when ? Date.parse(when.text()) : NaN;
      var name = link.text();

      out.push({
        url: path,
        name: name || path,
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        dateUpload: isNaN(parsed) ? null : parsed
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.charAt(0) !== '/') path = '/' + path;
    var body = kuma.http.get(kuma.baseUrl + path);

    // Matched by image host rather than by the array's variable name, which
    // differs from page to page.
    var matches = kuma.regex.all(PAGE_URL, '', body);
    var out = [];
    var seen = {};
    for (var i = 0; i < matches.length; i++) {
      var url = matches[i][0];
      if (!url || seen[url]) continue;
      seen[url] = true;
      out.push({ url: url });
    }
    return out;
  }
};
