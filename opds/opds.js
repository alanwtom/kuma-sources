/*
 * OPDS — Kuma JavaScript source.
 *
 * One source for every server that speaks OPDS 1.2: Komga, Kavita,
 * Calibre-Web, Ubooquity, and anything else implementing the standard. That
 * is the whole point of it — the dedicated Komga and Kavita sources are
 * better on their own servers (real metadata, library filtering), but this
 * reaches the ones nobody will ever write a source for.
 *
 * What makes it work as a *manga* source is the Page Streaming Extension:
 *
 *   <link href=".../books/ID/pages/{pageNumber}" pse:count="53"/>
 *
 * Plain OPDS only offers whole files to download, which the reader cannot
 * show. A server without PSE will list series and chapters here and then have
 * no pages, so `getPageList` says so rather than returning an empty chapter.
 *
 * Atom is parsed with `kuma.html` — it is tag-and-attribute markup, which is
 * exactly what that parser handles, and it saves carrying an XML parser for
 * one source.
 */

var DEFAULT_CATALOG = '/opds/v1.2/catalog';

// Rel values from the OPDS and Atom specs.
var REL = {
  subsection: 'subsection',
  acquisition: 'http://opds-spec.org/acquisition',
  image: 'http://opds-spec.org/image',
  thumbnail: 'http://opds-spec.org/image/thumbnail',
  search: 'search',
  next: 'next'
};

function catalogPath() {
  var configured = kuma.config.get('catalogPath');
  if (!configured) return DEFAULT_CATALOG;
  var path = String(configured);
  return path.charAt(0) === '/' ? path : '/' + path;
}

/** Absolute for fetching, relative for storing — the server may move. */
function absolute(href) {
  return kuma.absoluteUrl(String(href || '').replace(/^\s+|\s+$/g, ''));
}

function relative(href) {
  var value = absolute(href);
  return value.indexOf(kuma.baseUrl) === 0 ? value.slice(kuma.baseUrl.length) : value;
}

function fetchFeed(pathOrUrl) {
  return kuma.html.parse(kuma.http.get(absolute(pathOrUrl)));
}

function linkWithRel(node, rel) {
  var links = node.select('link');
  for (var i = 0; i < links.length; i++) {
    if (links[i].attr('rel') === rel) return links[i];
  }
  return null;
}

/** The page-streaming link, identified by its count attribute. */
function pseLink(node) {
  var links = node.select('link');
  for (var i = 0; i < links.length; i++) {
    if (links[i].attr('pse:count')) return links[i];
  }
  return null;
}

function entryTitle(entry) {
  var title = entry.selectFirst('title');
  return title ? title.text() : '';
}

// MARK: - Discovery
//
// A catalogue is a tree, and every server arranges it differently. Rather
// than hard-coding Komga's layout, the browse feed is found by walking the
// root's navigation entries once and keeping whichever looks like "everything".

var browseFeedCache = null;
var searchTemplateCache = null;

function browseFeed() {
  if (browseFeedCache !== null) return browseFeedCache;

  var configured = kuma.config.get('browsePath');
  if (configured) {
    browseFeedCache = configured.charAt(0) === '/' ? configured : '/' + configured;
    return browseFeedCache;
  }

  var root = fetchFeed(catalogPath());
  var entries = root.select('entry');
  var preferred = null;
  var fallback = null;

  for (var i = 0; i < entries.length; i++) {
    var link = linkWithRel(entries[i], REL.subsection);
    if (!link) continue;
    var href = relative(link.attr('href'));
    var title = entryTitle(entries[i]).toLowerCase();

    if (!fallback) fallback = href;
    // "All series" and "Browse" are the conventional names for the whole
    // catalogue; "Keep reading" and "On deck" are personalised shelves that
    // would make browse look nearly empty.
    if (/all series|all books|browse|^series$|^libraries$/.test(title)) {
      preferred = href;
      break;
    }
  }

  browseFeedCache = preferred || fallback || catalogPath();
  return browseFeedCache;
}

function searchTemplate() {
  if (searchTemplateCache !== null) return searchTemplateCache || null;

  var root = fetchFeed(catalogPath());
  var link = linkWithRel(root, REL.search);
  if (!link) { searchTemplateCache = ''; return null; }

  // The search link points at an OpenSearch description, which holds the
  // real template. Some servers point straight at a templated feed instead.
  var href = absolute(link.attr('href'));
  if (href.indexOf('{searchTerms}') >= 0 || href.indexOf('{query}') >= 0) {
    searchTemplateCache = href;
    return searchTemplateCache;
  }

  var description = kuma.html.parse(kuma.http.get(href));
  var urls = description.select('url');
  for (var i = 0; i < urls.length; i++) {
    var template = urls[i].attr('template');
    if (template && template.indexOf('{searchTerms}') >= 0) {
      searchTemplateCache = template;
      return searchTemplateCache;
    }
  }
  searchTemplateCache = '';
  return null;
}

// MARK: - Decoding

function decodeSeriesEntry(entry) {
  var link = linkWithRel(entry, REL.subsection);
  if (!link) return null;

  var thumbnail = linkWithRel(entry, REL.thumbnail) || linkWithRel(entry, REL.image);
  return {
    url: relative(link.attr('href')),
    title: entryTitle(entry) || 'Untitled',
    thumbnailUrl: thumbnail ? absolute(thumbnail.attr('href')) : '',
    status: 'Unknown'
  };
}

/**
 * A book entry becomes a chapter. The page-streaming template and count are
 * carried in the url so opening a chapter needs no extra request — OPDS has
 * no per-book feed to re-read them from.
 */
function decodeBookEntry(entry, index) {
  var pse = pseLink(entry);
  if (!pse) return null;

  var count = parseInt(pse.attr('pse:count'), 10);
  if (isNaN(count) || count < 1) return null;

  var title = entryTitle(entry) || ('Chapter ' + (index + 1));
  var number = parseFloat(kuma.regex.first('([0-9]+(?:\\.[0-9]+)?)', '', title));

  var updated = entry.selectFirst('updated');
  var parsed = updated ? Date.parse(updated.text()) : NaN;

  return {
    url: relative(pse.attr('href')) + '|pse=' + count,
    name: title,
    chapterNumber: isNaN(number) ? null : number,
    dateUpload: isNaN(parsed) ? null : parsed
  };
}

function listSeries(feedPath, page) {
  var n = parseInt(page, 10);
  if (isNaN(n) || n < 1) n = 1;

  // OPDS pages by following `rel="next"`, so reaching page N means walking
  // there. Feeds are small and the server is the user's own, but the walk is
  // capped so a server that always advertises a next page cannot spin.
  var path = feedPath;
  var feed = fetchFeed(path);
  for (var step = 1; step < n && step < 50; step++) {
    var next = linkWithRel(feed, REL.next);
    if (!next) return [];
    feed = fetchFeed(next.attr('href'));
  }

  var entries = feed.select('entry');
  var out = [];
  for (var i = 0; i < entries.length; i++) {
    var mapped = decodeSeriesEntry(entries[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

var KumaSource = {
  // OPDS has no popularity or recency ordering of its own; both browse the
  // catalogue. Inventing an order would misrepresent the server's.
  fetchPopular: function (page) {
    return listSeries(browseFeed(), page);
  },

  fetchLatest: function (page) {
    return listSeries(browseFeed(), page);
  },

  fetchSearch: function (text, page) {
    var template = searchTemplate();
    if (!template) return [];
    var url = template
      .split('{searchTerms}').join(encodeURIComponent(text))
      .split('{query}').join(encodeURIComponent(text));
    // Strip any other unfilled OpenSearch parameters.
    url = url.replace(/\{[^}]*\}/g, '');
    return listSeries(url, page);
  },

  getMangaDetails: function (url) {
    var feed = fetchFeed(url);
    var title = feed.selectFirst('title');
    var details = { url: relative(url), status: 'Unknown', genres: [] };
    if (title) details.title = title.text();
    return details;
  },

  getChapterList: function (url) {
    var feed = fetchFeed(url);
    var entries = feed.select('entry');
    var out = [];
    var withoutPages = 0;

    for (var i = 0; i < entries.length; i++) {
      var mapped = decodeBookEntry(entries[i], i);
      if (mapped) out.push(mapped);
      else if (linkWithRel(entries[i], REL.acquisition)) withoutPages += 1;
    }

    // Everything here is a downloadable file with no page streaming — an
    // ebook shelf, or a server without the extension. Saying so beats an
    // empty chapter list that looks like a parsing failure.
    if (!out.length && withoutPages > 0) {
      throw new Error('This server offers these as whole files to download, not as pages Kuma can show. It needs OPDS page streaming.');
    }
    return out;
  },

  getPageList: function (chapterUrl) {
    var raw = String(chapterUrl || '');
    var split = raw.lastIndexOf('|pse=');
    if (split < 0) return [];

    var template = raw.slice(0, split);
    var count = parseInt(raw.slice(split + 5), 10);
    if (isNaN(count) || count < 1) return [];

    var out = [];
    // PSE numbers pages from one.
    for (var page = 1; page <= count; page++) {
      out.push({ url: absolute(template.split('{pageNumber}').join(String(page))) });
    }
    return out;
  }
};
