/*
 * Weeb Central — Kuma JavaScript source.
 *
 * A scraped source: the site serves HTML, not an API, so this reads the page
 * with `kuma.html` rather than `getJSON`.
 *
 * Two things about the site shape it relies on:
 *  - It is htmx-driven, so the useful endpoints return HTML fragments rather
 *    than whole pages: `/search/data` for every listing, `/full-chapter-list`
 *    for chapters, `/images` for pages. Scraping the full pages instead would
 *    mean parsing 160 KB of navigation to reach 8 KB of content.
 *  - One listing row contains several links to the same series (the cover is
 *    one anchor, the title another). Rows are therefore keyed by series id and
 *    merged, not taken one-per-anchor, or every result appears twice.
 *
 * Being a scrape, this breaks when the site is redesigned. Everything it
 * depends on is a selector in SELECTORS below, so a break is usually one line.
 */

// Fixed by the site: /search/data returns 32 rows whatever `limit` says.
var PAGE_SIZE = 32;

var SELECTORS = {
  seriesLink: "a[href*='/series/']",
  cover: 'img',
  listTitle: '.truncate',
  chapterLink: "a[href*='/chapters/']",
  // The row is: an icon span, then a wrapper holding the name plus "Last
  // Read" and "new" markers, then a <time>. Matching plain `span` picks the
  // icon, whose text is empty, and falling back to the row's own text glues
  // the timestamp onto every chapter name.
  chapterName: 'span.grow > span',
  chapterTime: 'time[datetime]',
  pageImage: '#chapter-images img',
  detailTitle: 'h1',
  detailDescription: 'p.whitespace-pre-wrap',
  detailMetaRow: 'li',
  detailMetaLabel: 'strong',
  detailMetaValue: 'a'
};

function query(pairs) {
  var parts = [];
  for (var i = 0; i < pairs.length; i++) {
    var value = pairs[i][1];
    if (value === null || value === undefined || value === '') continue;
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(value));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

function offsetFor(page) {
  var n = parseInt(page, 10);
  if (isNaN(n) || n < 1) n = 1;
  return (n - 1) * PAGE_SIZE;
}

// MARK: - Identifiers

function seriesIdFrom(href) {
  return kuma.regex.first('/series/([^/?#]+)', '', String(href || ''));
}

function chapterIdFrom(href) {
  return kuma.regex.first('/chapters/([^/?#]+)', '', String(href || ''));
}

/**
 * "inuta-my-canine-classmate" -> "Inuta My Canine Classmate".
 *
 * Only a fallback. The slug loses punctuation and capitalisation, so it is
 * used when the row carries no title element rather than in preference to one.
 */
function titleFromSlug(href) {
  var slug = kuma.regex.first('/series/[^/]+/([^/?#]+)', '', String(href || ''));
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
 * The chapter's own label, without the badges sharing its row.
 *
 * Skips anything holding an icon — the "Last Read" and "new chapter" markers
 * are spans too — and if the markup moves, falls back to the row text with
 * the timestamp and marker trimmed off rather than returning them as a name.
 */
function chapterNameFrom(anchor) {
  var candidates = anchor.select(SELECTORS.chapterName);
  for (var i = 0; i < candidates.length; i++) {
    if (candidates[i].selectFirst('svg') || candidates[i].selectFirst('img')) continue;
    var text = candidates[i].text();
    if (text) return text;
  }

  var whole = anchor.text();
  var time = anchor.selectFirst(SELECTORS.chapterTime);
  if (time) whole = whole.split(time.text()).join('');
  return whole.replace(/\s*Last Read\s*$/i, '').trim();
}

// MARK: - Listings

/**
 * Reads a listing fragment into manga rows.
 *
 * Keyed by series id because a row links to the same series more than once and
 * each anchor carries a different part of what we need — the cover sits in
 * one, the readable title in another. Taking one row per anchor would both
 * duplicate every result and leave half of them untitled.
 */
function parseListing(html) {
  var anchors = kuma.html.parse(html).select(SELECTORS.seriesLink);
  var byId = {};
  var order = [];

  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i];
    var href = anchor.attr('href');
    var id = seriesIdFrom(href);
    if (!id) continue;

    if (!byId[id]) {
      byId[id] = { url: '/series/' + id, title: '', thumbnailUrl: '', slug: titleFromSlug(href) };
      order.push(id);
    }
    var entry = byId[id];

    if (!entry.thumbnailUrl) {
      var image = anchor.selectFirst(SELECTORS.cover);
      if (image) entry.thumbnailUrl = image.absAttr('src');
    }
    if (!entry.title) {
      var label = anchor.selectFirst(SELECTORS.listTitle);
      var text = label ? label.text() : '';
      // The cover anchor also holds an "Official" ribbon that matches the
      // same class, so a badge must not be mistaken for the title.
      if (text && text.toLowerCase() !== 'official') entry.title = text;
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

function listing(page, sort, text) {
  var url = kuma.baseUrl + '/search/data' + query([
    ['text', text],
    ['sort', sort],
    ['order', 'Descending'],
    ['official', 'Any'],
    ['display_mode', 'Full Display'],
    ['limit', PAGE_SIZE],
    ['offset', offsetFor(page)]
  ]);
  return parseListing(kuma.http.get(url));
}

// MARK: - Source

var KumaSource = {
  fetchPopular: function (page) {
    return listing(page, 'Popularity', null);
  },

  fetchLatest: function (page) {
    return listing(page, 'Latest Updates', null);
  },

  fetchSearch: function (text, page) {
    return listing(page, 'Best Match', text);
  },

  getMangaDetails: function (url) {
    var id = seriesIdFrom(url) || String(url || '').replace(/^\/+/, '');
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/series/' + id));

    var details = { url: '/series/' + id, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle);
    if (heading) details.title = heading.text();

    var summary = doc.selectFirst(SELECTORS.detailDescription);
    if (summary) details.description = summary.text();

    var cover = doc.selectFirst('picture ' + SELECTORS.cover) || doc.selectFirst(SELECTORS.cover);
    if (cover) details.thumbnailUrl = cover.absAttr('src');

    // The metadata is a list of "<strong>Label</strong> value" rows with no
    // stable class per field, so it is matched on the label text. A selector
    // engine with no :contains cannot express that, and hard-coding row order
    // would break the first time the site adds a field.
    var rows = doc.select(SELECTORS.detailMetaRow);
    for (var i = 0; i < rows.length; i++) {
      var label = rows[i].selectFirst(SELECTORS.detailMetaLabel);
      if (!label) continue;
      var name = label.text().toLowerCase();
      var values = rows[i].select(SELECTORS.detailMetaValue);
      var texts = [];
      for (var v = 0; v < values.length; v++) {
        var value = values[v].text();
        if (value) texts.push(value);
      }

      if (name.indexOf('author') === 0) {
        if (texts.length) details.author = texts[0];
        if (texts.length > 1) details.artist = texts[1];
      } else if (name.indexOf('tag') === 0 || name.indexOf('genre') === 0) {
        details.genres = texts;
      } else if (name.indexOf('status') === 0) {
        details.status = statusOf(rows[i].text().replace(label.text(), ''));
      }
    }
    return details;
  },

  getChapterList: function (url) {
    var id = seriesIdFrom(url) || String(url || '').replace(/^\/+/, '');
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + '/series/' + id + '/full-chapter-list'));
    var anchors = doc.select(SELECTORS.chapterLink);

    var out = [];
    var seen = {};
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i];
      var chapterId = chapterIdFrom(anchor.attr('href'));
      if (!chapterId || seen[chapterId]) continue;
      seen[chapterId] = true;

      var name = chapterNameFrom(anchor);

      var uploaded = null;
      var time = anchor.selectFirst(SELECTORS.chapterTime);
      if (time) {
        var parsed = Date.parse(time.attr('datetime'));
        if (!isNaN(parsed)) uploaded = parsed;
      }

      out.push({
        url: '/chapters/' + chapterId,
        name: name || 'Chapter',
        chapterNumber: parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name)),
        dateUpload: uploaded
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var id = chapterIdFrom(chapterUrl) || String(chapterUrl || '').replace(/^\/+/, '');
    var url = kuma.baseUrl + '/chapters/' + id + '/images' + query([
      ['is_prev', 'False'],
      ['current_page', 1],
      ['reading_style', 'long_strip']
    ]);
    var images = kuma.html.parse(kuma.http.get(url)).select(SELECTORS.pageImage);

    var out = [];
    for (var i = 0; i < images.length; i++) {
      var src = images[i].absAttr('src');
      if (src) out.push({ url: src });
    }
    return out;
  }
};

// Site vocabulary onto SMangaStatus raw values.
function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('ongoing') >= 0) return 'Ongoing';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  if (text.indexOf('complete') >= 0) return 'Completed';
  if (text.indexOf('cancel') >= 0) return 'Unknown';
  return 'Unknown';
}
