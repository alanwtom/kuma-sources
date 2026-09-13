/*
 * MangaThemesia — one Kuma source bundle for every site running the theme.
 *
 * MangaThemesia (the old Mangastream / "Asura" WordPress theme) is the engine
 * most scanlation groups that aren't on Madara use. Sixteen live English sites
 * were walked end to end before this shipped, and the whole difference between
 * them is **one path segment** — `/manga/`, `/series/` or `/comics/` — which
 * arrives from the manifest as `kuma.options.seriesPath`. Everything else here
 * is the theme's, not any one site's.
 *
 * Why this engine is worth having: the reader page hands over a JSON blob
 * (`ts_reader.run({… images:[…] …})`) instead of markup. That is more stable
 * than parsing, and it skips the advert images some sites inject among the real
 * pages — the same reason Flame Comics reads `__NEXT_DATA__`.
 *
 * Five things cost real probing time, and every one of them fails *silently* —
 * the source returns plausible results and the reader shows the wrong thing:
 *
 *  - **A locked chapter row has an `<a>` with no `href`.** Sites selling early
 *    access render the row as a modal trigger. A regex that walks from the row
 *    to "the next link" pairs chapter 233 with chapter 232's URL, and then
 *    every row below it is off by one.
 *  - **A row can be a client-side template**: `<li data-num="{{number}}">` with
 *    `href="#/chapter-{{number}}"`. It looks like the newest chapter and opens
 *    nothing.
 *  - **Search paginates differently from browse.** Browse is
 *    `/{prefix}/?page=2`; search is `/page/2/?s=q`. Sending `?s=q&page=2`
 *    returns page one again, so search would repeat its first ten results
 *    forever.
 *  - **The reader blob is sometimes base64.** Sites running the Autoptimize
 *    plugin emit `<script src="data:text/javascript;base64,…">` instead of
 *    inline JS. Reading only the inline form gives a chapter of zero pages.
 *  - **Some series are novels.** `ts_reader` reports `is_novel: true` and an
 *    empty image list. Nothing to do about it here beyond not shipping a site
 *    that is all novels — but see the notes file before adding one.
 *
 * Being a scrape, this breaks when a site is redesigned. Everything it depends
 * on is in SELECTORS below, so a break is usually one line.
 */

// The host ends a listing at fewer than 20 rows (`JSSource.swift`). Sites serve
// 10 search hits a page, so one Kuma page is two of the site's or search stops
// dead after the first screen. Browse pages are bigger and pay one extra
// request for the same rule — the alternative is an index that drifts.
var SITE_PAGES_PER_KUMA_PAGE = 2;

var SELECTORS = {
  // The theme's grid cell. `div.listupd` is the container around it and is the
  // fallback for sites whose child theme renamed the cell but kept the grid.
  listingCell: 'div.bsx',
  listingContainer: 'div.listupd',
  listingTitle: 'div.tt',

  detailTitle: 'h1.entry-title',
  detailCover: 'div.thumb',
  detailDescription: 'div.entry-content',
  detailGenres: 'span.mgen',
  // Two generations of the theme describe a series differently: the newer one
  // uses label/value blocks, the older a two-column table.
  detailInfoBlock: 'div.imptdt',
  detailInfoTable: 'table.infotable tr',

  chapterList: '#chapterlist',
  chapterRow: 'li',
  chapterName: 'span.chapternum',
  chapterDate: 'span.chapterdate',

  // Reader fallbacks, tried only when the JSON blob is missing. The capitalised
  // id is a real site, not a typo — `HTMLSelector` matches ids exactly.
  readerArea: '#readerarea',
  readerAreaAlt: '#readerArea'
};

// MARK: - Options

/** `/manga/`, `/series/`, `/comics/` — the one thing that varies per site. */
function seriesPath() {
  var raw = (kuma.options && kuma.options.seriesPath) || 'manga';
  return String(raw).replace(/^\/+/, '').replace(/\/+$/, '') || 'manga';
}

function orderFor(key, fallback) {
  var raw = kuma.options && kuma.options[key];
  return raw ? String(raw) : fallback;
}

// MARK: - Small helpers

function trimmed(value) {
  return String(value === null || value === undefined ? '' : value).replace(/^\s+|\s+$/g, '');
}

function clean(value) {
  return kuma.decodeEntities(trimmed(value)).replace(/\s+/g, ' ');
}

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

/**
 * The site-relative path of a link, whatever form the markup used.
 *
 * Chapter and series hrefs are usually absolute and occasionally rooted, and
 * some sites prefix a series slug with a random number
 * (`/comics/0086250808-i-got-the-weakest-…/`). Keeping the path the site gave
 * us is the only safe move — a reconstructed URL 404s on those sites while
 * still looking like a working link.
 */
function pathOf(href) {
  var value = trimmed(href);
  if (!value) return '';
  var stripped = value.replace(/^https?:\/\/[^/]+/i, '');
  if (!stripped) return '/';
  return stripped.charAt(0) === '/' ? stripped : '/' + stripped;
}

/**
 * An address the host can actually turn into a URL.
 *
 * At least one site stores its pages in folders with spaces in the name
 * (`…/Chapter 161/00.jpg`) and serves the space raw. `URL(string:)` rejects
 * that, so the page is dropped without an error and the chapter comes up
 * short — encode it here rather than at every call site.
 */
function safeUrl(raw) {
  return trimmed(raw).split(' ').join('%20');
}

/** Lazy-loading plugins move the real address off `src`; try those first. */
function imageFrom(node) {
  if (!node) return '';
  var raw = safeUrl(node.attr('data-src'))
    || safeUrl(node.attr('data-lazy-src'))
    || safeUrl(node.attr('src'));
  return raw ? kuma.absoluteUrl(raw) : '';
}

// MARK: - Listings

/**
 * Reads a browse, latest or search page into manga rows.
 *
 * Keyed by path and merged: the theme links a series from the cover and again
 * from the title, and a child theme can add a third link in the chapter strip
 * below the cover. One row per anchor duplicates every result.
 */
function parseListing(html) {
  var doc = kuma.html.parse(html);
  var prefix = '/' + seriesPath() + '/';

  var cells = doc.select(SELECTORS.listingCell);
  var anchors = [];
  for (var c = 0; c < cells.length; c++) {
    var first = cells[c].selectFirst('a');
    if (first) anchors.push(first);
  }

  // A child theme that renamed `bsx` usually keeps the grid it sits in. Falling
  // back to every series link inside that grid picks the same rows up, and the
  // dedup below absorbs the extra anchors per cell.
  if (!anchors.length) {
    var containers = doc.select(SELECTORS.listingContainer);
    for (var g = 0; g < containers.length; g++) {
      var links = containers[g].select("a[href*='" + prefix + "']");
      for (var l = 0; l < links.length; l++) anchors.push(links[l]);
    }
  }

  var order = [];
  var byPath = {};

  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i];
    var path = pathOf(anchor.attr('href'));
    // The grid also holds links to the chapters under each cover; those sit at
    // the site root and must not become library entries.
    if (!path || path.indexOf(prefix) !== 0) continue;
    if (path === prefix) continue;

    if (!byPath[path]) {
      byPath[path] = { url: path, title: '', thumbnailUrl: '' };
      order.push(path);
    }
    var row = byPath[path];

    if (!row.title) {
      // The anchor's `title` attribute is the reliable one; the cell's own text
      // is the title plus the rating, the type badge and the latest chapter.
      row.title = clean(anchor.attr('title'));
    }
    if (!row.title) {
      var label = anchor.selectFirst(SELECTORS.listingTitle);
      if (label) row.title = clean(label.text());
    }
    var cover = anchor.selectFirst('img');
    if (!row.title && !cover) {
      // Last resort, and only for an anchor holding no artwork. A child theme
      // can put the title in a plain text link beside the cover link, but the
      // cover link's own text is the whole cell — rating, type badge and latest
      // chapter glued onto the name — so it must never be used as a title.
      row.title = clean(anchor.text());
    }
    if (!row.thumbnailUrl) row.thumbnailUrl = imageFrom(cover);
  }

  var out = [];
  for (var j = 0; j < order.length; j++) {
    var entry = byPath[order[j]];
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
 * One Kuma page from two of the site's, deduplicated.
 *
 * The second fetch is skipped when the first came back empty, so running off
 * the end of a small catalogue costs one request rather than two, and must not
 * be able to fail the first — some sites answer a past-the-end page with a 404
 * and losing a good page of results to that would make search look broken.
 */
function listingPage(urlFor, page) {
  var n = pageNumber(page);
  var base = (n - 1) * SITE_PAGES_PER_KUMA_PAGE + 1;

  var out = parseListing(kuma.http.get(urlFor(base)));
  if (!out.length) return [];

  var seen = {};
  for (var s = 0; s < out.length; s++) seen[out[s].url] = true;

  for (var extra = 1; extra < SITE_PAGES_PER_KUMA_PAGE; extra++) {
    var res = kuma.http.tryGet(urlFor(base + extra));
    if (!res.ok) break;
    var more = parseListing(res.body);
    for (var m = 0; m < more.length; m++) {
      if (seen[more[m].url]) continue;
      seen[more[m].url] = true;
      out.push(more[m]);
    }
  }
  return out;
}

function browseUrl(n, order) {
  return kuma.baseUrl + '/' + seriesPath() + '/?page=' + n + '&order=' + encodeURIComponent(order);
}

/**
 * WordPress paginates a search by path, not by query.
 *
 * `/?s=q&page=2` answers with page one — the same ten titles — so search would
 * look like it worked and never advance.
 */
function searchUrl(n, text) {
  var suffix = '?s=' + encodeURIComponent(text);
  return n > 1 ? kuma.baseUrl + '/page/' + n + '/' + suffix : kuma.baseUrl + '/' + suffix;
}

// MARK: - Details

function statusOf(value) {
  var text = String(value || '').toLowerCase();
  if (text.indexOf('ongoing') >= 0 || text.indexOf('publishing') >= 0) return 'Ongoing';
  if (text.indexOf('hiatus') >= 0) return 'On Hiatus';
  if (text.indexOf('complete') >= 0 || text.indexOf('finished') >= 0) return 'Completed';
  return 'Unknown';
}

/** Applies one "Status: Ongoing" style fact to the details being built. */
function applyFact(details, label, value) {
  var name = String(label || '').toLowerCase();
  var text = clean(value);
  if (!text || text === 'n/a' || text === '-') return;

  if (name.indexOf('status') >= 0) details.status = statusOf(text);
  else if (name.indexOf('author') >= 0) details.author = text;
  else if (name.indexOf('artist') >= 0) details.artist = text;
}

// MARK: - Reader

/**
 * The JSON argument of `ts_reader.run({…})`, by brace balance.
 *
 * A non-greedy regex happens to work on most sites and stops early on any that
 * put a `})` inside the blob, which would drop every page after it — counting
 * braces costs nothing and cannot do that.
 */
function readerArgument(text) {
  var marker = 'ts_reader.run(';
  var start = text.indexOf(marker);
  if (start < 0) return null;

  var open = text.indexOf('{', start);
  if (open < 0) return null;

  var depth = 0;
  var inString = false;
  var escaped = false;

  for (var i = open; i < text.length; i++) {
    var ch = text.charAt(i);
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

var BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * JavaScriptCore has no `atob` — it is a browser API, not a language one — and
 * sites running the Autoptimize plugin serve the reader script as a
 * `data:text/javascript;base64,…` URL rather than inline.
 *
 * Only ASCII is decoded, which is all the reader blob contains: it is JSON with
 * every non-ASCII character already escaped as `\uXXXX`.
 */
function decodeBase64(input) {
  var text = String(input || '').replace(/[^A-Za-z0-9+/=]/g, '');
  var out = '';
  var i = 0;

  while (i < text.length) {
    var c1 = BASE64_ALPHABET.indexOf(text.charAt(i++));
    var c2 = BASE64_ALPHABET.indexOf(text.charAt(i++));
    var c3 = BASE64_ALPHABET.indexOf(text.charAt(i++));
    var c4 = BASE64_ALPHABET.indexOf(text.charAt(i++));
    if (c1 < 0 || c2 < 0) break;

    out += String.fromCharCode((c1 << 2) | (c2 >> 4));
    if (c3 >= 0) out += String.fromCharCode(((c2 & 15) << 4) | (c3 >> 2));
    if (c4 >= 0) out += String.fromCharCode(((c3 & 3) << 6) | c4);
  }
  return out;
}

/** The reader blob, inline if it is there and out of a base64 script if not. */
function readerData(html) {
  var direct = readerArgument(html);
  if (direct) return parseReader(direct);

  var re = /data:text\/javascript;base64,([A-Za-z0-9+/=]+)/g;
  var match;
  while ((match = re.exec(html)) !== null) {
    var decoded = decodeBase64(match[1]);
    if (decoded.indexOf('ts_reader.run(') < 0) continue;
    var found = readerArgument(decoded);
    if (found) return parseReader(found);
  }
  return null;
}

function parseReader(json) {
  try {
    return JSON.parse(json);
  } catch (error) {
    console.log('mangathemesia: ts_reader payload did not parse — ' + error);
    return null;
  }
}

// MARK: - Source

var KumaSource = {
  fetchPopular: function (page) {
    var order = orderFor('popularOrder', 'popular');
    return listingPage(function (n) { return browseUrl(n, order); }, page);
  },

  fetchLatest: function (page) {
    var order = orderFor('latestOrder', 'update');
    return listingPage(function (n) { return browseUrl(n, order); }, page);
  },

  fetchSearch: function (text, page) {
    return listingPage(function (n) { return searchUrl(n, text); }, page);
  },

  getMangaDetails: function (url) {
    var path = pathOf(url) || '/' + seriesPath() + '/';
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + path));

    var details = { url: path, status: 'Unknown', genres: [] };

    var heading = doc.selectFirst(SELECTORS.detailTitle) || doc.selectFirst('h1');
    if (heading) details.title = clean(heading.text());

    var thumb = doc.selectFirst(SELECTORS.detailCover);
    details.thumbnailUrl = imageFrom(thumb ? thumb.selectFirst('img') : null);
    if (!details.thumbnailUrl) {
      // Every one of these sites is a WordPress install with Open Graph tags,
      // so the share image is the cover on any child theme that renamed the
      // container. Cheaper and steadier than guessing at the new class.
      var og = doc.selectFirst("meta[property='og:image']");
      if (og) details.thumbnailUrl = kuma.absoluteUrl(trimmed(og.attr('content')));
    }

    var summary = doc.selectFirst(SELECTORS.detailDescription);
    if (summary) details.description = clean(summary.text());

    var genreBox = doc.selectFirst(SELECTORS.detailGenres);
    var genreLinks = genreBox ? genreBox.select('a') : doc.select("a[href*='/genres/']");
    var seenGenre = {};
    for (var g = 0; g < genreLinks.length; g++) {
      var genre = clean(genreLinks[g].text());
      if (!genre || seenGenre[genre]) continue;
      seenGenre[genre] = true;
      details.genres.push(genre);
    }

    // Newer theme: a label and a value in the same block. Two sites out of
    // three wrap the label in a heading; the rest leave it as the block's own
    // loose text ("Status <i>Ongoing</i>"), so reading only the heading finds
    // nothing and every series on those sites reports an unknown status.
    var blocks = doc.select(SELECTORS.detailInfoBlock);
    for (var b = 0; b < blocks.length; b++) {
      var value = blocks[b].selectFirst('i') || blocks[b].selectFirst('a');
      if (!value) continue;
      var heading = blocks[b].selectFirst('h1') || blocks[b].selectFirst('h2');
      var label = heading ? heading.text() : blocks[b].textExcluding(value);
      applyFact(details, label, value.text());
    }

    // Older theme: a two-column table. Both are read, because a site mid-way
    // through a theme update can carry one of each.
    var rows = doc.select(SELECTORS.detailInfoTable);
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].select('td');
      if (cells.length < 2) continue;
      applyFact(details, cells[0].text(), cells[1].text());
    }
    return details;
  },

  getChapterList: function (url) {
    var path = pathOf(url);
    var doc = kuma.html.parse(kuma.http.get(kuma.baseUrl + path));

    var list = doc.selectFirst(SELECTORS.chapterList);
    var rows = list ? list.select(SELECTORS.chapterRow) : doc.select('li[data-num]');

    var out = [];
    var seen = {};

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var anchor = row.selectFirst('a');
      if (!anchor) continue;

      var href = trimmed(anchor.attr('href'));
      // A row with no address is either a chapter the site is selling early
      // access to — it opens a purchase modal — or the client-side template the
      // "load more" button clones. Both look like ordinary rows.
      if (!href || href.charAt(0) === '#' || href.indexOf('{{') >= 0) continue;

      var chapterPath = pathOf(href);
      if (!chapterPath || seen[chapterPath]) continue;
      seen[chapterPath] = true;

      var label = row.selectFirst(SELECTORS.chapterName);
      var name = clean(label ? label.text() : anchor.text());

      // `data-num` is the site's own ordering and is right far more often than
      // a number scraped out of a name like "Chapter 12 - The End". It is only
      // trusted when it is actually a number: some sites put a slug there.
      var number = parseFloat(trimmed(row.attr('data-num')));
      if (isNaN(number)) {
        number = parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', name) || '');
      }

      var date = row.selectFirst(SELECTORS.chapterDate);
      var uploaded = null;
      if (date) {
        var parsed = Date.parse(clean(date.text()));
        if (!isNaN(parsed)) uploaded = parsed;
      }

      out.push({
        url: chapterPath,
        name: name || 'Chapter',
        chapterNumber: number,
        dateUpload: uploaded
      });
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var path = pathOf(chapterUrl);
    var html = kuma.http.get(kuma.baseUrl + path);

    var out = [];
    var seen = {};

    function add(raw) {
      var src = kuma.absoluteUrl(safeUrl(raw));
      if (!src || seen[src]) return;
      // A spacer, a logo or the "loading" placeholder sitting in the reader is
      // not a page. Anything served out of the theme's own directory is
      // furniture, and every real page lives under the site's uploads.
      if (src.indexOf('/themes/') >= 0) return;
      if (/logo|placeholder|readerarea\.svg|loading\.gif|spacer/i.test(src)) return;
      seen[src] = true;
      out.push({ url: src });
    }

    var data = readerData(html);
    if (data && data.sources && data.sources.length) {
      // A site can offer several mirrors; the first is the one it defaults to,
      // and the rest hold the same pages.
      var images = data.sources[0].images || [];
      for (var i = 0; i < images.length; i++) add(images[i]);
      if (out.length) return out;
    }

    // No blob, or a blob with no images: fall back to the markup. This is the
    // shape older installs and heavily customised child themes still use.
    var doc = kuma.html.parse(html);
    var area = doc.selectFirst(SELECTORS.readerArea) || doc.selectFirst(SELECTORS.readerAreaAlt);
    var tags = area ? area.select('img') : [];
    for (var t = 0; t < tags.length; t++) add(imageFrom(tags[t]));

    return out;
  }
};
