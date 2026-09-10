/*
 * MangaFreak — Kuma JavaScript source.
 *
 * Plain server-rendered HTML, no framework and no obfuscation, which after
 * surveying a dozen sites is rarer than it sounds.
 *
 * The one awkward part is the series metadata: it is a run of unlabelled
 * `<div>`s inside one container — "This is COMPLETED series", "Written By:
 * …", "Year Published: …" — with no class distinguishing them. They are
 * matched on their own text, which is ugly but is what the markup offers.
 */

// The catalogue lists 18 a page and the host reads anything under 20 as the
// end of the list, so one Kuma page is two of the site's.
var CATALOG_ROWS_PER_PAGE = 18;

var SELECTORS = {
  listingRow: 'div.list_item',
  listingLink: "a[href^='/Manga/']",
  cover: 'img',
  listingTitle: 'h3',
  detailContainer: 'div.manga_series_data',
  detailTitle: 'h1',
  detailFact: 'div',
  detailCover: 'div.manga_series_image',
  detailDescription: 'div.manga_series_description',
  detailGenres: 'div.series_sub_genre_list',
  // The full run, with dates. `series_sub_chapter_list` higher up the page
  // looks like the chapter list and is only a four-item preview — taking it
  // silently caps every series at four chapters.
  chapterList: 'div.manga_series_list',
  chapterRow: 'tr',
  chapterLink: 'a.chapter-link',
  pageImage: 'img#gohere'
};

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

function slugFrom(url) {
  return kuma.regex.first('/Manga/([^/?#]+)', '', String(url || ''))
    || String(url || '').replace(/^\/+/, '');
}

function parseListing(html) {
  var doc = kuma.html.parse(html);
  var rows = doc.select(SELECTORS.listingRow);
  // Latest-releases pages use a different wrapper; falling back to the links
  // themselves keeps one parser for both.
  var anchors = rows.length ? null : doc.select(SELECTORS.listingLink);

  var out = [];
  var seen = {};

  function push(slug, title, cover) {
    if (!slug || seen[slug] || !title) return;
    seen[slug] = true;
    out.push({ url: '/Manga/' + slug, title: title, thumbnailUrl: cover || '', status: 'Unknown' });
  }

  if (rows.length) {
    for (var i = 0; i < rows.length; i++) {
      var link = rows[i].selectFirst(SELECTORS.listingLink);
      if (!link) continue;
      // The row's own text runs the title into the status, chapter count and
      // synopsis, so the heading has to be selected rather than read off the
      // row: "Some Title Status: Ongoing Released: 23 Chapters".
      var heading = rows[i].selectFirst(SELECTORS.listingTitle);
      var image = rows[i].selectFirst(SELECTORS.cover);
      var title = heading ? heading.text() : link.text();
      push(slugFrom(link.attr('href')), title, image ? image.absAttr('src') : '');
    }
    return out;
  }

  for (var j = 0; j < anchors.length; j++) {
    var anchor = anchors[j];
    var slug = slugFrom(anchor.attr('href'));
    var img = anchor.selectFirst(SELECTORS.cover);
    var name = anchor.text() || slug.replace(/_/g, ' ');
    push(slug, name, img ? img.absAttr('src') : '');
  }
  return out;
}

/** One Kuma page from two of the site's, deduplicated. */
function catalogPage(urlFor, page) {
  var n = pageNumber(page);
  var first = parseListing(kuma.http.get(urlFor(n * 2 - 1)));
  if (!first.length) return [];

  var out = first.slice(0);
  var seen = {};
  for (var i = 0; i < out.length; i++) seen[out[i].url] = true;

  var second = parseListing(kuma.http.get(urlFor(n * 2)));
  for (var j = 0; j < second.length; j++) {
    if (!seen[second[j].url]) out.push(second[j]);
  }
  return out;
}

function statusOf(text) {
  // Letters only: the site writes "This is ON-GOING series", and matching
  // "ongoing" against that hyphen fails while looking perfectly correct.
  var value = String(text || '').toLowerCase().replace(/[^a-z]/g, '');
  if (value.indexOf('completed') >= 0) return 'Completed';
  if (value.indexOf('ongoing') >= 0) return 'Ongoing';
  if (value.indexOf('hiatus') >= 0) return 'On Hiatus';
  return 'Unknown';
}

var KumaSource = {
  // The site exposes no popularity order, so this is the catalogue as listed.
  fetchPopular: function (page) {
    return catalogPage(function (n) { return kuma.baseUrl + '/Mangalist/All/' + n; }, page);
  },

  fetchLatest: function (page) {
    return parseListing(kuma.http.get(kuma.baseUrl + '/Latest_Releases/' + pageNumber(page)));
  },

  fetchSearch: function (text, page) {
    // Search returns a single page of matches; later pages would repeat it.
    if (pageNumber(page) > 1) return [];
    return parseListing(kuma.http.get(kuma.baseUrl + '/Find/' + encodeURIComponent(text)));
  },

  getMangaDetails: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/Manga/' + slug));
    var details = { url: '/Manga/' + slug, status: 'Unknown', genres: [] };

    var data = doc.selectFirst(SELECTORS.detailContainer);
    if (data) {
      var heading = data.selectFirst(SELECTORS.detailTitle);
      if (heading) details.title = heading.text();

      // Unlabelled divs, matched on their own wording.
      var facts = data.select(SELECTORS.detailFact);
      for (var i = 0; i < facts.length; i++) {
        var text = facts[i].text();
        if (!text) continue;
        if (text.indexOf('This is') === 0) details.status = statusOf(text);
        else if (text.indexOf('Written By:') === 0) details.author = text.slice(11).replace(/^\s+/, '');
        else if (text.indexOf('Illustrated By:') === 0) details.artist = text.slice(15).replace(/^\s+/, '');
      }
    }

    var coverBox = doc.selectFirst(SELECTORS.detailCover);
    var cover = coverBox ? coverBox.selectFirst(SELECTORS.cover) : null;
    if (cover) details.thumbnailUrl = cover.absAttr('src');

    var summary = doc.selectFirst(SELECTORS.detailDescription);
    if (summary) {
      var paragraph = summary.selectFirst('p');
      // The block opens with the word "Synopsis"; the paragraph is the text.
      details.description = paragraph ? paragraph.text() : summary.text();
    }

    var genreBox = doc.selectFirst(SELECTORS.detailGenres);
    if (genreBox) {
      var links = genreBox.select('a');
      for (var g = 0; g < links.length; g++) {
        var genre = links[g].text();
        if (genre) details.genres.push(genre);
      }
    }
    return details;
  },

  getChapterList: function (url) {
    var slug = slugFrom(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/Manga/' + slug));
    var box = doc.selectFirst(SELECTORS.chapterList);
    if (!box) return [];

    var rows = box.select(SELECTORS.chapterRow);
    var out = [];
    var seen = {};

    for (var i = 0; i < rows.length; i++) {
      var link = rows[i].selectFirst(SELECTORS.chapterLink);
      if (!link) continue;
      var href = String(link.attr('href') || '');
      if (!href || seen[href]) continue;
      seen[href] = true;

      // Cells are title, date, bookmark, download — the date has no class of
      // its own, and there are no sibling combinators, so it is taken by
      // position within the row.
      var cells = rows[i].select('td');
      var uploaded = null;
      if (cells.length > 1) {
        var parsed = Date.parse(cells[1].text().split('/').join('-'));
        if (!isNaN(parsed)) uploaded = parsed;
      }

      var name = link.text() || href;
      out.push({
        url: href.charAt(0) === '/' ? href : '/' + href,
        name: name,
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        dateUpload: uploaded
      });
    }
    // The table runs oldest first; the reader expects newest at the top.
    out.reverse();
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = String(chapterUrl || '');
    if (path.charAt(0) !== '/') path = '/' + path;
    var images = kuma.html.parse(kuma.http.get(kuma.baseUrl + path)).select(SELECTORS.pageImage);

    var out = [];
    var seen = {};
    for (var i = 0; i < images.length; i++) {
      var src = images[i].absAttr('src');
      if (!src || seen[src]) continue;
      seen[src] = true;
      out.push({ url: src });
    }
    return out;
  }
};
