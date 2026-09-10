/*
 * Suwayomi — Kuma JavaScript source.
 *
 * Reads a Suwayomi (Tachidesk) server the user runs themselves. This is the
 * one source that reaches the Mihon/keiyoushi ecosystem: those extensions are
 * Android code Kuma cannot execute, but a Suwayomi server can, and it exposes
 * whatever it has installed over GraphQL. Point Kuma at that server and its
 * extensions become readable here.
 *
 * Two modes, chosen by whether the "Source" setting is filled in:
 *
 *  - **Blank (the default): your library.** Browsing shows what you have
 *    saved on the server, which is the reason most people connect to their
 *    own machine in the first place.
 *  - **A source name: that source's catalogue.** This is how a keiyoushi
 *    extension installed on the server becomes browsable from the phone.
 *
 * Everything is one GraphQL endpoint, so every call is a POST. Page images
 * and covers are ordinary URLs on the same server, and the host attaches the
 * login to them — see the `auth` block in the manifest.
 */

var PAGE_SIZE = 30;

function endpoint() {
  return kuma.baseUrl + '/api/graphql';
}

/**
 * One GraphQL call.
 *
 * Errors arrive as HTTP 200 with an `errors` array, so a plain `ok` check
 * would treat a failed query as an empty result and show an empty shelf
 * instead of saying anything.
 */
function graphql(query, variables) {
  var res = kuma.http.request('POST', endpoint(), JSON.stringify({
    query: query,
    variables: variables || {}
  }), { 'Content-Type': 'application/json' });

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error('The server refused the login. Check the username and password.');
    }
    throw new Error(res.error || ('The server returned HTTP ' + res.status));
  }

  var body;
  try {
    body = JSON.parse(res.body);
  } catch (e) {
    throw new Error("That address answered, but not like a Suwayomi server. Check it's the right one.");
  }
  if (body.errors && body.errors.length) {
    throw new Error(body.errors[0].message || 'The server rejected that request.');
  }
  return body.data || {};
}

// MARK: - Source selection

var sourceIdCache = null;

/** The configured source's id, or null to use the library instead. */
function sourceId() {
  var wanted = kuma.config.get('source');
  if (!wanted) return null;
  if (sourceIdCache !== null) return sourceIdCache || null;

  var data = graphql('{ sources { nodes { id name } } }');
  var nodes = (data.sources && data.sources.nodes) || [];
  var target = String(wanted).toLowerCase();

  for (var i = 0; i < nodes.length; i++) {
    if (String(nodes[i].name || '').toLowerCase() === target) {
      sourceIdCache = nodes[i].id;
      return sourceIdCache;
    }
  }

  // Naming a source the server doesn't have is a typo worth reporting:
  // silently falling back to the library would look like the setting was
  // ignored.
  var names = [];
  for (var j = 0; j < nodes.length && j < 8; j++) names.push(nodes[j].name);
  throw new Error('No source called "' + wanted + '" on that server.'
    + (names.length ? ' It has: ' + names.join(', ') + '.' : ' It has no sources installed.'));
}

// MARK: - Decoding

function decodeManga(node) {
  if (!node || node.id === undefined || node.id === null) return null;
  return {
    url: '/manga/' + node.id,
    title: node.title || 'Untitled',
    // Relative to the server, so it has to be resolved before the reader
    // fetches it.
    thumbnailUrl: node.thumbnailUrl ? kuma.absoluteUrl(node.thumbnailUrl) : '',
    status: statusOf(node.status)
  };
}

// Suwayomi reuses Tachiyomi's vocabulary.
function statusOf(value) {
  switch (String(value || '').toUpperCase()) {
    case 'ONGOING': return 'Ongoing';
    case 'COMPLETED': return 'Completed';
    case 'PUBLISHING_FINISHED': return 'Finished';
    case 'ON_HIATUS': return 'On Hiatus';
    case 'LICENSED': return 'Licensed';
    // CANCELLED has no equivalent; calling it Completed would be a lie.
    default: return 'Unknown';
  }
}

function mangaId(url) {
  var match = kuma.regex.first('/manga/(\\d+)', '', String(url || ''));
  return match ? parseInt(match, 10) : parseInt(String(url || '').replace(/^\/+/, ''), 10);
}

function pageNumber(page) {
  var n = parseInt(page, 10);
  return (isNaN(n) || n < 1) ? 1 : n;
}

// MARK: - Listing

var SOURCE_MANGA = 'mutation Browse($source: LongString!, $type: FetchSourceMangaType!, $page: Int!, $query: String) {'
  + ' fetchSourceManga(input: {source: $source, type: $type, page: $page, query: $query})'
  + ' { hasNextPage mangas { id title thumbnailUrl status } } }';

var LIBRARY = 'query Library($first: Int!, $offset: Int!) {'
  + ' mangas(condition: {inLibrary: true}, first: $first, offset: $offset)'
  + ' { nodes { id title thumbnailUrl status } } }';

var LIBRARY_SEARCH = 'query LibrarySearch($first: Int!, $offset: Int!, $title: String!) {'
  + ' mangas(condition: {inLibrary: true}, filter: {title: {likeInsensitive: $title}}, first: $first, offset: $offset)'
  + ' { nodes { id title thumbnailUrl status } } }';

function fromSource(type, page, query) {
  var data = graphql(SOURCE_MANGA, {
    source: sourceId(), type: type, page: pageNumber(page), query: query || null
  });
  var result = data.fetchSourceManga || {};
  var out = [];
  for (var i = 0; i < (result.mangas || []).length; i++) {
    var mapped = decodeManga(result.mangas[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

function fromLibrary(page, query) {
  var offset = (pageNumber(page) - 1) * PAGE_SIZE;
  var data = query
    ? graphql(LIBRARY_SEARCH, { first: PAGE_SIZE, offset: offset, title: '%' + query + '%' })
    : graphql(LIBRARY, { first: PAGE_SIZE, offset: offset });

  var nodes = (data.mangas && data.mangas.nodes) || [];
  var out = [];
  for (var i = 0; i < nodes.length; i++) {
    var mapped = decodeManga(nodes[i]);
    if (mapped) out.push(mapped);
  }
  return out;
}

var KumaSource = {
  fetchPopular: function (page) {
    return sourceId() ? fromSource('POPULAR', page, null) : fromLibrary(page, null);
  },

  fetchLatest: function (page) {
    // A library has no "latest" of its own; browsing it twice is honest,
    // where inventing an order would not be.
    return sourceId() ? fromSource('LATEST', page, null) : fromLibrary(page, null);
  },

  fetchSearch: function (text, page) {
    return sourceId() ? fromSource('SEARCH', page, text) : fromLibrary(page, text);
  },

  getMangaDetails: function (url) {
    var id = mangaId(url);
    var data = graphql(
      'query Detail($id: Int!) { manga(id: $id)'
      + ' { id title author artist description genre status thumbnailUrl } }',
      { id: id }
    );
    var node = data.manga;
    if (!node) return { url: '/manga/' + id };

    var details = decodeManga(node) || { url: '/manga/' + id };
    if (node.author) details.author = node.author;
    if (node.artist) details.artist = node.artist;
    if (node.description) details.description = node.description;
    details.genres = node.genre || [];
    return details;
  },

  getChapterList: function (url) {
    var id = mangaId(url);
    // `fetchChapters` is a mutation because it asks the server to refresh
    // from the underlying source; the plain query would return whatever was
    // last cached and miss new chapters.
    var data = graphql(
      'mutation Chapters($id: Int!) { fetchChapters(input: {mangaId: $id})'
      + ' { chapters { id name chapterNumber scanlator uploadDate } } }',
      { id: id }
    );
    var chapters = (data.fetchChapters && data.fetchChapters.chapters) || [];

    var out = [];
    for (var i = 0; i < chapters.length; i++) {
      var chapter = chapters[i];
      if (chapter.id === undefined || chapter.id === null) continue;

      // uploadDate arrives as a string of milliseconds.
      var uploaded = parseInt(chapter.uploadDate, 10);
      var number = parseFloat(chapter.chapterNumber);

      out.push({
        url: '/chapter/' + chapter.id,
        name: chapter.name || ('Chapter ' + (isNaN(number) ? i + 1 : number)),
        chapterNumber: isNaN(number) || number < 0 ? null : number,
        scanlator: chapter.scanlator || null,
        dateUpload: isNaN(uploaded) || uploaded <= 0 ? null : uploaded
      });
    }
    out.reverse();
    return out;
  },

  getPageList: function (chapterUrl) {
    var match = kuma.regex.first('/chapter/(\\d+)', '', String(chapterUrl || ''));
    var id = parseInt(match || String(chapterUrl || '').replace(/^\/+/, ''), 10);
    if (isNaN(id)) return [];

    var data = graphql(
      'mutation Pages($id: Int!) { fetchChapterPages(input: {chapterId: $id}) { pages } }',
      { id: id }
    );
    var pages = (data.fetchChapterPages && data.fetchChapterPages.pages) || [];

    var out = [];
    for (var i = 0; i < pages.length; i++) {
      if (pages[i]) out.push({ url: kuma.absoluteUrl(pages[i]) });
    }
    return out;
  }
};
