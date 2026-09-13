/*
 * Iken — one Kuma source bundle for every site running the Iken CMS.
 *
 * Seven sites ship against this file and nothing varies between them but the
 * address in the manifest, so there are no `kuma.options` here. If a future
 * site needs one, it is a real difference worth a comment, not a knob added
 * on spec.
 *
 * Why this engine is different from every other bundle in packs/: Iken sites
 * are Next.js App Router, which the project otherwise refuses to scrape — but
 * they expose a complete public JSON API with no key and no login, so nothing
 * here touches markup at all. A site redesign cannot break this file.
 *
 * The three endpoints, all verified live on all seven sites:
 *
 *   GET /api/query?page=1&perPage=20&seriesType=…&orderBy=…&searchTerm=…
 *       → { posts: [ { id, slug, postTitle, featuredImage, … } ], totalCount }
 *   GET /api/post?postSlug=<slug>
 *       → { post: { … }, firstChapter, lastChapter, totalChapterCount }
 *   GET /api/chapters?postId=<id>
 *       → { post: { chapters: [ … ] }, totalChapterCount }
 *   GET /api/chapter?mangaslug=<slug>&chapterslug=<slug>
 *       → { chapter: { images: [ { url, order } ] } }
 *
 * IMPORTANT — the API lives on the `api.` host, not the site's own.
 * `https://<site>/api/query` answers on every site, but `/api/post` and
 * `/api/chapters` return the site's 404 *page* on six of the seven. Browse
 * would work and every title would open to nothing. The manifest points at
 * `https://api.<site>` for all of them, which serves all four endpoints.
 *
 * Runtime notes (see JSHostBridge.swift):
 *  - JavaScriptCore only. No fetch, no XMLHttpRequest, no timers.
 *  - Every exported function is SYNCHRONOUS; `kuma.http.getJSON` blocks this
 *    source's own JS thread and returns the parsed body.
 *  - The host derives `hasNextPage` from `results.length >= 20`, so a browse
 *    call must return a full twenty whenever more exist — which is why novels
 *    are excluded by the API rather than filtered out here. See SERIES_TYPES.
 */

var PAGE_SIZE = 20;

/**
 * Comic series types, sent to the API so novels never reach the reader.
 *
 * Iken sites host prose novels beside comics — 32 of the first 300 titles on
 * one of them. A novel chapter answers HTTP 200 with `images: []` and seven
 * thousand characters of text, so it opens to a blank reader rather than an
 * error: exactly the silent failure this project designs against.
 *
 * Filtering server-side rather than dropping rows after the fact is what keeps
 * pagination honest. A filtered page of 19 tells the host there is no next
 * page, and browse stops dead one screen in.
 *
 * MANHWA, MANHUA and MANGA are the three seen in the wild; COMIC and WEBTOON
 * are accepted by the API and cost nothing, so a site that starts using one
 * doesn't quietly vanish from the shelf. The live test asserts that this list
 * still accounts for every non-novel title.
 */
var SERIES_TYPES = 'MANHWA,MANHUA,MANGA,COMIC,WEBTOON';

/**
 * Post ids keyed by slug, for the life of this source's JS context.
 *
 * `/api/chapters` takes a numeric post id and nothing else — no slug form
 * exists. Without this, every chapter-list refresh costs a second round trip
 * to `/api/post` purely to translate a slug we already looked up when the
 * user opened the title. Ids are database keys and never change, so there is
 * nothing to invalidate.
 */
var postIds = {};

// MARK: - Helpers

function query(pairs) {
  var parts = [];
  for (var i = 0; i < pairs.length; i++) {
    if (pairs[i][1] === '' || pairs[i][1] == null) continue;
    parts.push(encodeURIComponent(pairs[i][0]) + '=' + encodeURIComponent(pairs[i][1]));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/**
 * Reads an endpoint and insists the body is the shape we asked for.
 *
 * Iken reports missing records with honest status codes — 404 with
 * `{"error":"Post not found"}` — which `kuma.http.getJSON` already throws on.
 * This guards the other direction: a body that parses but carries an `error`
 * instead of the key we need. Both Suwayomi and AniList answer HTTP 200 on a
 * refused query, and reading the status alone turns that into an empty shelf.
 */
function fetchJSON(path, expecting) {
  var response = kuma.http.getJSON(kuma.baseUrl + path);
  if (!response || response[expecting] == null) {
    var reason = response && (response.error || response.message);
    throw new Error('Iken: ' + (reason || 'no "' + expecting + '" in the response for ' + path));
  }
  return response;
}

/** Trailing segments of `/series/<slug>` or `/series/<slug>/<chapter>`. */
function segments(url) {
  return String(url || '').split('/').filter(function (part) {
    return part.length > 0;
  });
}

/** Must return a raw value of `SMangaStatus`, not Iken's own vocabulary. */
function statusOf(raw) {
  switch (String(raw || '').toUpperCase()) {
    case 'ONGOING': return 'Ongoing';
    case 'MASS_RELEASED': return 'Ongoing';
    case 'COMPLETED': return 'Finished';
    case 'HIATUS': return 'On Hiatus';
    // Iken has no separate "abandoned" state, and the reader needs to know the
    // wait is over either way.
    case 'DROPPED': return 'Completed';
    case 'CANCELLED': return 'Completed';
    // A title with no chapters yet. "Unknown" reads better than a wrong claim.
    case 'COMING_SOON': return 'Unknown';
    default: return 'Unknown';
  }
}

/** Genres arrive as `[{id, name, color}]`; some sites leave trailing spaces. */
function genreNames(raw) {
  var out = [];
  var list = raw || [];
  for (var i = 0; i < list.length; i++) {
    var name = typeof list[i] === 'string' ? list[i] : (list[i] && list[i].name);
    name = String(name || '').replace(/^\s+|\s+$/g, '');
    if (name) out.push(name);
  }
  return out;
}

/** One comma-separated string on the wire, a list everywhere else. */
function altTitles(raw) {
  var out = [];
  var parts = String(raw || '').split(',');
  for (var i = 0; i < parts.length; i++) {
    var trimmed = parts[i].replace(/^\s+|\s+$/g, '');
    if (trimmed) out.push(trimmed);
  }
  return out;
}

function decodePost(post) {
  if (post && post.slug) postIds[post.slug] = post.id;

  var description = post.postContent ? kuma.stripTags(post.postContent) : null;
  var author = String(post.author || '').replace(/^\s+|\s+$/g, '');
  var artist = String(post.artist || '').replace(/^\s+|\s+$/g, '');

  return {
    url: '/series/' + post.slug,
    title: post.postTitle || 'Untitled',
    altTitles: altTitles(post.alternativeTitles),
    author: author || null,
    artist: artist || null,
    description: description || null,
    genres: genreNames(post.genres),
    status: statusOf(post.seriesStatus),
    thumbnailUrl: post.featuredImage || null
  };
}

/**
 * Whether the site will actually serve this chapter's pages to a signed-out
 * reader.
 *
 * Iken sells early access in site coins, and there are two separate locks. A
 * paid chapter carries `isPermanentlyLocked: true` with a `price`. A timed
 * early-access chapter carries `isPermanentlyLocked: FALSE` and an `unlockAt`
 * date — checking the permanent flag alone lets those through, and they are
 * the newest chapters, so they sit at the top of the list.
 *
 * Both answer `/api/chapter` with HTTP 200 and `images: []`, which is a blank
 * reader rather than an error. `isAccessible` is the site's own verdict and
 * covers both; the rest are belt and braces for a site running an older build
 * that doesn't send it.
 */
function isReadable(chapter) {
  if (chapter.isAccessible === false) return false;
  if (chapter.isLocked === true) return false;
  if (chapter.isPermanentlyLocked === true) return false;
  if (chapter.unlockAt) {
    var unlocks = Date.parse(chapter.unlockAt);
    if (!isNaN(unlocks) && unlocks > Date.now()) return false;
  }
  return true;
}

/** "Chapter 12", "Chapter 12.5", "Chapter 200 - Calculated Intent". */
function chapterLabel(chapter) {
  var number = chapter.number;
  var printed = (typeof number === 'number' && isFinite(number))
    ? String(number)
    : String(chapter.slug || '').replace(/-/g, ' ');
  var label = 'Chapter ' + printed;
  var title = String(chapter.title || '').replace(/^\s+|\s+$/g, '');
  if (title) label += ' - ' + title;
  return label;
}

function browse(page, extraPairs) {
  var pairs = [
    ['page', String(Math.max(1, page))],
    ['perPage', String(PAGE_SIZE)],
    ['seriesType', SERIES_TYPES],
    ['order', 'desc']
  ].concat(extraPairs || []);

  var response = fetchJSON('/api/query' + query(pairs), 'posts');
  var out = [];
  for (var i = 0; i < response.posts.length; i++) out.push(decodePost(response.posts[i]));
  return out;
}

/** Slug → numeric post id, from the cache when we've already paid for it. */
function postId(slug) {
  if (postIds[slug] != null) return postIds[slug];
  var response = fetchJSON('/api/post' + query([['postSlug', slug]]), 'post');
  decodePost(response.post);
  return response.post.id;
}

// MARK: - Exported source

var KumaSource = {
  fetchPopular: function (page) {
    // `orderBy` is honoured; the `sortBy` the site's own browse screen sends is
    // silently ignored by the API, which is why this doesn't use it.
    return browse(page, [['orderBy', 'totalViews']]);
  },

  fetchLatest: function (page) {
    // Newest chapter first, not newest series — a series added months ago that
    // updated this morning belongs at the top of a "latest" shelf.
    return browse(page, [['orderBy', 'latest']]);
  },

  fetchSearch: function (q, page) {
    var trimmed = String(q || '').replace(/^\s+|\s+$/g, '');
    // An unrecognised parameter name doesn't fail here — it returns the whole
    // unfiltered catalogue, which looks like a working search with terrible
    // results. `searchTerm` is the one the API reads.
    return browse(page, trimmed ? [['searchTerm', trimmed]] : []);
  },

  getMangaDetails: function (url) {
    var parts = segments(url);
    var slug = parts.length ? parts[parts.length - 1] : '';
    if (!slug) throw new Error('Iken: no series slug in ' + url);

    var response = fetchJSON('/api/post' + query([['postSlug', slug]]), 'post');
    return decodePost(response.post);
  },

  getChapterList: function (url) {
    var parts = segments(url);
    var slug = parts.length ? parts[parts.length - 1] : '';
    if (!slug) throw new Error('Iken: no series slug in ' + url);

    var response = fetchJSON('/api/chapters' + query([['postId', String(postId(slug))]]), 'post');
    var raw = response.post.chapters || [];

    var chapters = [];
    for (var i = 0; i < raw.length; i++) {
      if (!isReadable(raw[i])) continue;
      var published = raw[i].createdAt ? Date.parse(raw[i].createdAt) : NaN;
      chapters.push({
        url: '/series/' + slug + '/' + raw[i].slug,
        name: chapterLabel(raw[i]),
        chapterNumber: typeof raw[i].number === 'number' ? raw[i].number : 0,
        // The host divides by 1000; `Date.parse` already yields milliseconds.
        dateUpload: isNaN(published) ? null : published
      });
    }
    return chapters;
  },

  getPageList: function (chapterUrl) {
    // Insist on the full `/series/<series>/<chapter>` shape. Reading the last
    // two segments alone would accept a *series* URL and quietly ask for
    // "chapter series-slug", which the API answers with a 404 the reader shows
    // as a failed page load rather than as the mix-up it is.
    var parts = segments(chapterUrl);
    if (parts.length < 3 || parts[parts.length - 3] !== 'series') {
      throw new Error('Iken: no chapter in ' + chapterUrl);
    }
    var chapterSlug = parts[parts.length - 1];
    var seriesSlug = parts[parts.length - 2];

    var response = fetchJSON(
      '/api/chapter' + query([['mangaslug', seriesSlug], ['chapterslug', chapterSlug]]),
      'chapter'
    );
    var images = response.chapter.images || [];

    // `getChapterList` drops everything the site says is locked, so reaching
    // here with nothing means either a chapter that was unlocked when the list
    // was fetched and isn't now, or one the site published with no artwork.
    // Both look identical to a blank screen, so say something instead.
    if (!images.length) {
      throw new Error('This chapter has no pages yet — it may be early access, or the site may not have uploaded it.');
    }

    // `order` is authoritative; the array has always matched it so far, but a
    // page out of sequence is the kind of thing nobody notices in review.
    var sorted = images.slice().sort(function (a, b) {
      return (a.order == null ? 0 : a.order) - (b.order == null ? 0 : b.order);
    });

    var pages = [];
    for (var i = 0; i < sorted.length; i++) {
      if (sorted[i] && sorted[i].url) pages.push(sorted[i].url);
    }
    if (!pages.length) throw new Error('Iken returned pages with no image addresses.');
    return pages;
  }
};
