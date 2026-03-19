/* ============================================
   BookmarkHub – newtab.js
   Full bookmark manager with tags, categories,
   folders, fuzzy search, and beautiful UI.
   ============================================ */

"use strict";

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────
const State = {
	allBookmarks: [], // flat list of Chrome bookmark nodes (leaves)
	folderTree: [], // raw Chrome bookmark tree (folders)
	metadata: {}, // { [bookmarkId]: { tags:[], category:'', notes:'' } }
	categories: [], // [{ id, name, color }]
	tags: [], // derived: unique tag strings
	settings: { theme: "dark", accent: "violet" },

	// View state
	currentFilter: "all",
	currentFolder: null,
	currentTag: null,
	currentCategory: null,
	searchQuery: "",
	sortMode: "date-desc",
	viewMode: "grid",

	// Detail/edit modal context
	activeBookmarkId: null,
};

// ──────────────────────────────────────────────
// STORAGE HELPERS
// ──────────────────────────────────────────────
const Storage = {
	async load() {
		return new Promise((resolve) => {
			chrome.storage.local.get(
				["metadata", "categories", "settings"],
				(data) => {
					State.metadata = data.metadata || {};
					State.categories = data.categories || [];
					State.settings = {
						theme: "dark",
						accent: "violet",
						...(data.settings || {}),
					};
					resolve();
				},
			);
		});
	},
	save() {
		chrome.storage.local.set({
			metadata: State.metadata,
			categories: State.categories,
			settings: State.settings,
		});
	},
};

// ──────────────────────────────────────────────
// BOOKMARK HELPERS
// ──────────────────────────────────────────────
function flattenBookmarks(nodes, results = []) {
	for (const node of nodes) {
		if (node.url) {
			results.push(node);
		} else if (node.children) {
			flattenBookmarks(node.children, results);
		}
	}
	return results;
}

function getFolders(nodes, results = []) {
	for (const node of nodes) {
		if (!node.url && node.id !== "0") {
			results.push(node);
			if (node.children) getFolders(node.children, results);
		}
	}
	return results;
}

function getHostname(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function getFaviconUrl(url) {
	try {
		const host = new URL(url).origin;
		return `https://www.google.com/s2/favicons?domain=${host}&sz=32`;
	} catch {
		return "";
	}
}

function getInitials(title) {
	return (title || "?").trim().charAt(0).toUpperCase();
}

function getMeta(id) {
	return State.metadata[id] || { tags: [], category: "", notes: "" };
}

function setMeta(id, patch) {
	State.metadata[id] = { ...getMeta(id), ...patch };
	Storage.save();
}

function deriveTags() {
	const tagSet = new Set();
	for (const bm of State.allBookmarks) {
		const meta = getMeta(bm.id);
		if (meta.tags) meta.tags.forEach((t) => tagSet.add(t));
	}
	State.tags = Array.from(tagSet).sort();
}

// ──────────────────────────────────────────────
// FUZZY SEARCH  (lightweight, no deps)
// ──────────────────────────────────────────────
function fuzzyMatch(text, query) {
	if (!query) return { match: true, score: 0, ranges: [] };
	text = text.toLowerCase();
	query = query.toLowerCase();

	// Fast substring first (higher score)
	const idx = text.indexOf(query);
	if (idx !== -1) {
		return {
			match: true,
			score: 100 + query.length,
			ranges: [[idx, idx + query.length - 1]],
		};
	}

	// Character-by-character fuzzy
	let qi = 0,
		ranges = [],
		rangeStart = -1;
	for (let ti = 0; ti < text.length && qi < query.length; ti++) {
		if (text[ti] === query[qi]) {
			if (rangeStart === -1) rangeStart = ti;
			qi++;
			if (qi === query.length || text[ti + 1] !== query[qi]) {
				ranges.push([rangeStart, ti]);
				rangeStart = -1;
			}
		} else if (rangeStart !== -1) {
			ranges.push([rangeStart, ti - 1]);
			rangeStart = -1;
		}
	}

	if (qi === query.length) {
		const consecutiveness = ranges.reduce((a, [s, e]) => a + (e - s + 1), 0);
		return { match: true, score: consecutiveness, ranges };
	}
	return { match: false, score: 0, ranges: [] };
}

function highlightText(text, ranges) {
	if (!ranges || ranges.length === 0) return escapeHtml(text);
	let result = "",
		last = 0;
	for (const [start, end] of ranges) {
		result += escapeHtml(text.slice(last, start));
		result += `<mark class="highlight">${escapeHtml(text.slice(start, end + 1))}</mark>`;
		last = end + 1;
	}
	result += escapeHtml(text.slice(last));
	return result;
}

function escapeHtml(str) {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// ──────────────────────────────────────────────
// FILTER & SORT
// ──────────────────────────────────────────────
function getFilteredBookmarks() {
	let list = [...State.allBookmarks];

	// Filter by quick filter
	if (State.currentFilter === "recent") {
		list = list
			.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0))
			.slice(0, 50);
	} else if (State.currentFilter === "untagged") {
		list = list.filter((bm) => !getMeta(bm.id).tags?.length);
	}

	// Filter by folder
	if (State.currentFolder) {
		list = list.filter((bm) => bm.parentId === State.currentFolder);
	}

	// Filter by tag
	if (State.currentTag) {
		list = list.filter((bm) =>
			getMeta(bm.id).tags?.includes(State.currentTag),
		);
	}

	// Filter by category
	if (State.currentCategory) {
		list = list.filter(
			(bm) => getMeta(bm.id).category === State.currentCategory,
		);
	}

	// Search
	if (State.searchQuery) {
		const q = State.searchQuery;
		const withScore = list
			.map((bm) => {
				const meta = getMeta(bm.id);
				const titleMatch = fuzzyMatch(bm.title || "", q);
				const urlMatch = fuzzyMatch(bm.url || "", q);
				const tagMatch = (meta.tags || []).some(
					(t) => fuzzyMatch(t, q).match,
				);
				const noteMatch = fuzzyMatch(meta.notes || "", q);
				const best = titleMatch.match
					? titleMatch
					: urlMatch.match
						? urlMatch
						: null;
				const anyMatch =
					titleMatch.match || urlMatch.match || tagMatch || noteMatch;
				return {
					bm,
					score: best ? best.score : 0,
					titleRanges: titleMatch.ranges,
					urlRanges: urlMatch.ranges,
					anyMatch,
				};
			})
			.filter((x) => x.anyMatch);
		withScore.sort((a, b) => b.score - a.score);
		return withScore;
	}

	// Sort
	list = sortBookmarks(list);

	return list.map((bm) => ({ bm, score: 0, titleRanges: [], urlRanges: [] }));
}

function sortBookmarks(list) {
	switch (State.sortMode) {
		case "date-desc":
			return list.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0));
		case "date-asc":
			return list.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
		case "alpha-asc":
			return list.sort((a, b) =>
				(a.title || "").localeCompare(b.title || ""),
			);
		case "alpha-desc":
			return list.sort((a, b) =>
				(b.title || "").localeCompare(a.title || ""),
			);
		default:
			return list;
	}
}

// ──────────────────────────────────────────────
// RENDER
// ──────────────────────────────────────────────
function render() {
	renderSidebar();
	renderBookmarks();
	updatePageTitle();
}

function renderSidebar() {
	// Count all
	document.getElementById("count-all").textContent = State.allBookmarks.length;

	// Tags
	deriveTags();
	renderTagsSidebar();

	// Folders
	renderFoldersTree();

	// Categories
	renderCategoriesSidebar();
}

function renderTagsSidebar() {
	const container = document.getElementById("tags-list");
	if (State.tags.length === 0) {
		container.innerHTML = `<span style="padding:4px 10px;font-size:12px;color:var(--text-3)">No tags yet</span>`;
		return;
	}
	container.innerHTML = State.tags
		.map((tag) => {
			const count = State.allBookmarks.filter((bm) =>
				getMeta(bm.id).tags?.includes(tag),
			).length;
			const isActive = State.currentTag === tag;
			const color = tagColor(tag);
			return `
      <button class="sidebar-tag ${isActive ? "active" : ""}" data-tag="${escapeHtml(tag)}">
        <span class="sidebar-tag-dot" style="background:${color}"></span>
        <span class="sidebar-tag-name">${escapeHtml(tag)}</span>
        <span class="sidebar-tag-count">${count}</span>
      </button>`;
		})
		.join("");

	container.querySelectorAll(".sidebar-tag").forEach((btn) => {
		btn.addEventListener("click", () => {
			const tag = btn.dataset.tag;
			if (State.currentTag === tag) {
				State.currentTag = null;
			} else {
				State.currentTag = tag;
				State.currentCategory = null;
				State.currentFolder = null;
				State.currentFilter = "all";
				updateNavActive(null);
			}
			renderBookmarks();
			renderTagsSidebar();
			renderCategoriesSidebar();
			renderFoldersTree();
			updateActiveFilters();
			updatePageTitle();
		});
	});
}

function tagColor(tag) {
	// Deterministic color from tag string
	const colors = [
		"#7c3aed",
		"#2563eb",
		"#059669",
		"#d97706",
		"#e11d48",
		"#0891b2",
		"#7c3aed",
		"#9333ea",
	];
	let hash = 0;
	for (let i = 0; i < tag.length; i++)
		hash = tag.charCodeAt(i) + ((hash << 5) - hash);
	return colors[Math.abs(hash) % colors.length];
}

function renderFoldersTree() {
	const container = document.getElementById("folders-tree");
	const folders = getFolders(State.folderTree);
	if (folders.length === 0) {
		container.innerHTML = "";
		return;
	}

	function buildFolder(node, depth = 0) {
		if (!node.children) return "";
		const count = node.children.filter((c) => c.url).length;
		const isActive = State.currentFolder === node.id;
		const indent = depth * 14;
		let html = `
      <button class="folder-item ${isActive ? "active" : ""}" data-folder-id="${node.id}" style="padding-left:${10 + indent}px">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" stroke="currentColor" stroke-width="2"/></svg>
        <span class="folder-item-name">${escapeHtml(node.title || "Untitled")}</span>
        ${count > 0 ? `<span class="folder-item-count">${count}</span>` : ""}
      </button>`;
		if (node.children) {
			for (const child of node.children) {
				if (!child.url) html += buildFolder(child, depth + 1);
			}
		}
		return html;
	}

	container.innerHTML = State.folderTree
		.map((root) => {
			if (!root.children) return "";
			return root.children
				.filter((n) => !n.url)
				.map((n) => buildFolder(n))
				.join("");
		})
		.join("");

	container.querySelectorAll(".folder-item").forEach((btn) => {
		btn.addEventListener("click", () => {
			const fid = btn.dataset.folderId;
			if (State.currentFolder === fid) {
				State.currentFolder = null;
			} else {
				State.currentFolder = fid;
				State.currentTag = null;
				State.currentCategory = null;
				State.currentFilter = "all";
				updateNavActive(null);
			}
			renderBookmarks();
			renderFoldersTree();
			renderTagsSidebar();
			renderCategoriesSidebar();
			updateActiveFilters();
			updatePageTitle();
		});
	});
}

function renderCategoriesSidebar() {
	const container = document.getElementById("categories-list");
	if (State.categories.length === 0) {
		container.innerHTML = `<span style="padding:4px 10px;font-size:12px;color:var(--text-3)">No categories yet</span>`;
		return;
	}
	container.innerHTML = State.categories
		.map((cat) => {
			const count = State.allBookmarks.filter(
				(bm) => getMeta(bm.id).category === cat.id,
			).length;
			const isActive = State.currentCategory === cat.id;
			return `
      <button class="category-item ${isActive ? "active" : ""}" data-cat-id="${cat.id}">
        <span class="category-dot" style="background:${cat.color}"></span>
        <span class="category-name">${escapeHtml(cat.name)}</span>
        <span class="category-count">${count}</span>
      </button>`;
		})
		.join("");

	container.querySelectorAll(".category-item").forEach((btn) => {
		btn.addEventListener("click", () => {
			const cid = btn.dataset.catId;
			if (State.currentCategory === cid) {
				State.currentCategory = null;
			} else {
				State.currentCategory = cid;
				State.currentTag = null;
				State.currentFolder = null;
				State.currentFilter = "all";
				updateNavActive(null);
			}
			renderBookmarks();
			renderCategoriesSidebar();
			renderTagsSidebar();
			renderFoldersTree();
			updateActiveFilters();
			updatePageTitle();
		});
	});
}

function renderBookmarks() {
	const grid = document.getElementById("bookmarks-grid");
	const empty = document.getElementById("empty-state");
	const results = getFilteredBookmarks();

	if (results.length === 0) {
		grid.innerHTML = "";
		empty.classList.remove("hidden");
		document.getElementById("empty-title").textContent = State.searchQuery
			? "No results found"
			: "No bookmarks here";
		document.getElementById("empty-desc").textContent = State.searchQuery
			? `No bookmarks match "${State.searchQuery}"`
			: "Add bookmarks to get started.";
		return;
	}

	empty.classList.add("hidden");

	if (State.viewMode === "grid") {
		grid.classList.remove("list-view");
		grid.innerHTML = results
			.map(({ bm, titleRanges, urlRanges }) =>
				renderCard(bm, titleRanges, urlRanges),
			)
			.join("");
	} else {
		grid.classList.add("list-view");
		grid.innerHTML = results
			.map(({ bm, titleRanges, urlRanges }) =>
				renderRow(bm, titleRanges, urlRanges),
			)
			.join("");
	}

	// Attach events
	grid.querySelectorAll("[data-bm-id]").forEach((el) => {
		const id = el.dataset.bmId;
		el.addEventListener("click", (e) => {
			if (
				e.target.closest(".bm-action-btn") ||
				e.target.closest(".bm-card-actions")
			)
				return;
			openBookmark(id);
		});
		el.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			showContextMenu(e, id);
		});
		const editBtn = el.querySelector('[data-action="edit"]');
		if (editBtn)
			editBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				openDetailModal(id);
			});
		const openBtn = el.querySelector('[data-action="open"]');
		if (openBtn)
			openBtn.addEventListener("click", (e) => {
				e.stopPropagation();

				chrome.bookmarks.get(id, (results) => {
					const bm = results[0];
					if (!bm?.url) return;

					chrome.tabs.create({
						url: bm.url,
						active: !(e.ctrlKey || e.metaKey), // Ctrl/Cmd → background tab
					});
				});
			});
	});
}

function renderCard(bm, titleRanges, urlRanges) {
	const meta = getMeta(bm.id);
	const host = getHostname(bm.url);
	const favicon = getFaviconUrl(bm.url);
	const title = bm.title || host || bm.url;
	const cat = State.categories.find((c) => c.id === meta.category);

	const titleHtml = titleRanges?.length
		? highlightText(title, titleRanges)
		: escapeHtml(title);
	const urlHtml = urlRanges?.length
		? highlightText(host, urlRanges)
		: escapeHtml(host);

	const tagsHtml = (meta.tags || [])
		.slice(0, 4)
		.map(
			(t) =>
				`<span class="bm-tag" style="background:${tagColor(t)}22;color:${tagColor(t)}">${escapeHtml(t)}</span>`,
		)
		.join("");

	const catHtml = cat
		? `<span class="bm-category-badge"><span class="bm-category-dot" style="background:${cat.color}"></span>${escapeHtml(cat.name)}</span>`
		: "";

	return `
    <div class="bm-card" data-bm-id="${bm.id}">
      <div class="bm-card-actions">
        <button class="bm-action-btn" data-action="edit" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="bm-action-btn" data-action="open" title="Open">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="bm-card-header">
        <img class="bm-favicon" src="${favicon}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
        <div class="bm-favicon-placeholder" style="display:none">${getInitials(title)}</div>
        <div class="bm-card-title">${titleHtml}</div>
      </div>
      <div class="bm-card-url">${urlHtml}</div>
      ${meta.tags?.length || cat ? `<div class="bm-card-tags">${tagsHtml}${catHtml}</div>` : ""}
    </div>`;
}

function renderRow(bm, titleRanges, urlRanges) {
	const meta = getMeta(bm.id);
	const host = getHostname(bm.url);
	const favicon = getFaviconUrl(bm.url);
	const title = bm.title || host || bm.url;

	const titleHtml = titleRanges?.length
		? highlightText(title, titleRanges)
		: escapeHtml(title);

	const tagsHtml = (meta.tags || [])
		.slice(0, 3)
		.map(
			(t) =>
				`<span class="bm-tag" style="background:${tagColor(t)}22;color:${tagColor(t)}">${escapeHtml(t)}</span>`,
		)
		.join("");

	return `
    <div class="bm-row" data-bm-id="${bm.id}">
      <img class="bm-row-favicon" src="${favicon}" alt="" onerror="this.style.display='none'"/>
      <span class="bm-row-title">${titleHtml}</span>
      <span class="bm-row-url">${escapeHtml(host)}</span>
      <div class="bm-row-tags">${tagsHtml}</div>
      <div class="bm-row-actions">
        <button class="bm-action-btn" data-action="edit" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="bm-action-btn" data-action="open" title="Open">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </div>`;
}

function updatePageTitle() {
	const title = document.getElementById("page-title");
	const sub = document.getElementById("page-subtitle");

	if (State.searchQuery) {
		title.textContent = "Search Results";
		const n = getFilteredBookmarks().length;
		sub.textContent = `${n} result${n !== 1 ? "s" : ""} for "${State.searchQuery}"`;
		return;
	}
	if (State.currentTag) {
		title.textContent = `#${State.currentTag}`;
		sub.textContent = "";
		return;
	}
	if (State.currentCategory) {
		const cat = State.categories.find((c) => c.id === State.currentCategory);
		title.textContent = cat ? cat.name : "Category";
		sub.textContent = "";
		return;
	}
	if (State.currentFolder) {
		const folders = getFolders(State.folderTree);
		const f = folders.find((f) => f.id === State.currentFolder);
		title.textContent = f ? f.title : "Folder";
		sub.textContent = "";
		return;
	}
	const labels = {
		all: "All Bookmarks",
		recent: "Recently Added",
		untagged: "Untagged",
	};
	title.textContent = labels[State.currentFilter] || "All Bookmarks";
	sub.textContent = "";
}

function updateActiveFilters() {
	const container = document.getElementById("active-filters");
	const chips = [];

	if (State.currentTag) {
		chips.push({
			label: `Tag: ${State.currentTag}`,
			clear: () => {
				State.currentTag = null;
				applyFilter();
			},
		});
	}
	if (State.currentCategory) {
		const cat = State.categories.find((c) => c.id === State.currentCategory);
		chips.push({
			label: `Category: ${cat?.name || State.currentCategory}`,
			clear: () => {
				State.currentCategory = null;
				applyFilter();
			},
		});
	}
	if (State.currentFolder) {
		const folders = getFolders(State.folderTree);
		const f = folders.find((f) => f.id === State.currentFolder);
		chips.push({
			label: `Folder: ${f?.title || "Folder"}`,
			clear: () => {
				State.currentFolder = null;
				applyFilter();
			},
		});
	}

	container.innerHTML = chips
		.map(
			(c, i) => `
    <span class="filter-chip">
      ${escapeHtml(c.label)}
      <button data-chip="${i}" aria-label="Remove filter">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
      </button>
    </span>`,
		)
		.join("");

	container.querySelectorAll("button[data-chip]").forEach((btn) => {
		btn.addEventListener("click", () => {
			chips[+btn.dataset.chip].clear();
		});
	});
}

function applyFilter() {
	renderBookmarks();
	renderSidebar();
	updateActiveFilters();
	updatePageTitle();
}

function updateNavActive(filter) {
	document.querySelectorAll(".nav-item[data-filter]").forEach((el) => {
		el.classList.toggle("active", el.dataset.filter === filter);
	});
}

// ──────────────────────────────────────────────
// BOOKMARK ACTIONS
// ──────────────────────────────────────────────
function openBookmark(id) {
	const bm = State.allBookmarks.find((b) => b.id === id);
	if (bm?.url) window.location.href = bm.url;
}

function openBookmarkNewTab(id) {
	const bm = State.allBookmarks.find((b) => b.id === id);
	if (bm?.url) chrome.tabs.create({ url: bm.url });
}

async function deleteBookmark(id) {
	try {
		await new Promise((res, rej) =>
			chrome.bookmarks.remove(id, (err) => (err ? rej(err) : res())),
		);
		delete State.metadata[id];
		Storage.save();
		State.allBookmarks = State.allBookmarks.filter((b) => b.id !== id);
		render();
		toast("Bookmark deleted", "success");
	} catch (e) {
		toast("Could not delete bookmark", "error");
	}
}

async function createBookmark(url, title, parentId) {
	return new Promise((res, rej) => {
		chrome.bookmarks.create({ url, title, parentId }, (node) => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res(node);
		});
	});
}

async function updateBookmarkNode(id, url, title) {
	return new Promise((res, rej) => {
		chrome.bookmarks.update(id, { url, title }, (node) => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res(node);
		});
	});
}

// ──────────────────────────────────────────────
// MODALS
// ──────────────────────────────────────────────
function openModal(id) {
	document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
	document.getElementById(id).classList.add("hidden");
}

// ---- Add Bookmark Modal ----
function openAddBookmarkModal() {
	document.getElementById("modal-bookmark-title").textContent = "Add Bookmark";
	document.getElementById("bm-url").value = "";
	document.getElementById("bm-title").value = "";
	document.getElementById("bm-notes").value = "";
	populateFolderSelect("bm-folder");
	populateCategorySelect("bm-category");
	clearTagChips("bm-tags-display", "bm-tag-input", []);
	State.activeBookmarkId = null;
	openModal("modal-bookmark");
	document.getElementById("bm-url").focus();
}

function populateFolderSelect(selectId) {
	const select = document.getElementById(selectId);
	const folders = getFolders(State.folderTree);
	select.innerHTML = folders
		.map(
			(f) =>
				`<option value="${f.id}">${escapeHtml(f.title || "Untitled")}</option>`,
		)
		.join("");
	// Default to "Bookmarks Bar" if present
	const bar = folders.find((f) => f.title === "Bookmarks bar" || f.id === "1");
	if (bar) select.value = bar.id;
}

function populateCategorySelect(selectId, currentVal = "") {
	const select = document.getElementById(selectId);
	select.innerHTML =
		`<option value="">None</option>` +
		State.categories
			.map(
				(c) =>
					`<option value="${c.id}" ${c.id === currentVal ? "selected" : ""}>${escapeHtml(c.name)}</option>`,
			)
			.join("");
	select.value = currentVal;
}

// ---- Tag chip input ----
const tagInputStates = {};

function setupTagInput(displayId, inputId, initialTags = []) {
	const state = { tags: [...initialTags] };
	tagInputStates[inputId] = state;

	const display = document.getElementById(displayId);
	const input = document.getElementById(inputId);
	const suggestionsId =
		inputId === "bm-tag-input" ? "tag-suggestions" : "detail-tag-suggestions";
	const suggestions = document.getElementById(suggestionsId);

	function refresh() {
		display.innerHTML = state.tags
			.map(
				(t) => `
      <span class="tag-chip">
        ${escapeHtml(t)}
        <button data-tag="${escapeHtml(t)}" aria-label="Remove">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none"><path d="M18 6 6 18M6 6l12 12" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>
        </button>
      </span>`,
			)
			.join("");
		display.querySelectorAll("button[data-tag]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				state.tags = state.tags.filter((t) => t !== btn.dataset.tag);
				refresh();
			});
		});
	}

	input.addEventListener("keydown", (e) => {
		if ((e.key === "Enter" || e.key === ",") && input.value.trim()) {
			e.preventDefault();
			addTag(input.value.trim().replace(/,/g, "").toLowerCase());
		} else if (e.key === "Backspace" && !input.value && state.tags.length) {
			state.tags.pop();
			refresh();
		}
	});

	function addTag(tag) {
		if (tag && !state.tags.includes(tag)) {
			state.tags.push(tag);
			refresh();
		}
		input.value = "";
		suggestions.classList.add("hidden");
	}

	input.addEventListener("input", () => {
		const q = input.value.trim().toLowerCase();
		if (!q) {
			suggestions.classList.add("hidden");
			return;
		}
		const matches = State.tags.filter(
			(t) => t.includes(q) && !state.tags.includes(t),
		);
		if (matches.length === 0) {
			suggestions.classList.add("hidden");
			return;
		}

		suggestions.innerHTML = matches
			.slice(0, 8)
			.map(
				(t) =>
					`<div class="tag-suggestion-item" data-tag="${escapeHtml(t)}">
         <span class="sidebar-tag-dot" style="background:${tagColor(t)};width:7px;height:7px;border-radius:50%;flex-shrink:0"></span>
         ${escapeHtml(t)}
       </div>`,
			)
			.join("");
		suggestions.classList.remove("hidden");

		// Position
		const rect = input.getBoundingClientRect();
		suggestions.style.top = `${rect.bottom + 4}px`;
		suggestions.style.left = `${rect.left}px`;

		suggestions.querySelectorAll(".tag-suggestion-item").forEach((item) => {
			item.addEventListener("click", () => addTag(item.dataset.tag));
		});
	});

	document.addEventListener(
		"click",
		(e) => {
			if (!e.target.closest(`#${suggestionsId}`) && e.target !== input) {
				suggestions.classList.add("hidden");
			}
		},
		{ capture: true },
	);

	refresh();
	return state;
}

function clearTagChips(displayId, inputId, initialTags) {
	return setupTagInput(displayId, inputId, initialTags);
}

// ---- Save new/edit bookmark ----
async function saveBookmark() {
	const url = document.getElementById("bm-url").value.trim();
	const title = document.getElementById("bm-title").value.trim();
	const folder = document.getElementById("bm-folder").value;
	const category = document.getElementById("bm-category").value;
	const notes = document.getElementById("bm-notes").value.trim();
	const tags = tagInputStates["bm-tag-input"]?.tags || [];

	if (!url) {
		toast("Please enter a URL", "error");
		return;
	}

	try {
		let id;
		if (State.activeBookmarkId) {
			const node = await updateBookmarkNode(
				State.activeBookmarkId,
				url,
				title,
			);
			id = node.id;
			// Update in local list
			const idx = State.allBookmarks.findIndex((b) => b.id === id);
			if (idx !== -1) {
				State.allBookmarks[idx].url = url;
				State.allBookmarks[idx].title = title;
			}
		} else {
			const node = await createBookmark(url, title || url, folder);
			id = node.id;
			State.allBookmarks.push(node);
		}
		setMeta(id, { tags, category, notes });
		closeModal("modal-bookmark");
		render();
		toast(
			State.activeBookmarkId ? "Bookmark updated" : "Bookmark added",
			"success",
		);
	} catch (e) {
		toast("Error saving bookmark", "error");
		console.error(e);
	}
}

// ---- Detail Modal ----
function openDetailModal(id) {
	const bm = State.allBookmarks.find((b) => b.id === id);
	if (!bm) return;

	const meta = getMeta(id);
	State.activeBookmarkId = id;

	document.getElementById("detail-title").textContent = bm.title || bm.url;
	const urlEl = document.getElementById("detail-url");
	urlEl.textContent = bm.url;
	urlEl.href = bm.url;

	const favicon = getFaviconUrl(bm.url);
	const faviconEl = document.getElementById("detail-favicon");
	faviconEl.src = favicon;
	faviconEl.onerror = () => (faviconEl.style.display = "none");

	populateCategorySelect("detail-category", meta.category || "");
	document.getElementById("detail-notes").value = meta.notes || "";
	setupTagInput("detail-tags-display", "detail-tag-input", meta.tags || []);

	openModal("modal-detail");
}

async function saveDetail() {
	const id = State.activeBookmarkId;
	if (!id) return;
	const tags = tagInputStates["detail-tag-input"]?.tags || [];
	const category = document.getElementById("detail-category").value;
	const notes = document.getElementById("detail-notes").value.trim();
	setMeta(id, { tags, category, notes });
	closeModal("modal-detail");
	render();
	toast("Saved", "success");
}

// ──────────────────────────────────────────────
// CONTEXT MENU
// ──────────────────────────────────────────────
let contextTargetId = null;

function showContextMenu(e, id) {
	contextTargetId = id;
	const menu = document.getElementById("context-menu");
	menu.classList.remove("hidden");

	let x = e.clientX,
		y = e.clientY;
	const { innerWidth, innerHeight } = window;
	const { offsetWidth: w, offsetHeight: h } = menu;
	if (x + w > innerWidth) x = innerWidth - w - 8;
	if (y + h > innerHeight) y = innerHeight - h - 8;
	menu.style.left = `${x}px`;
	menu.style.top = `${y}px`;
}

function hideContextMenu() {
	document.getElementById("context-menu").classList.add("hidden");
	contextTargetId = null;
}

// ──────────────────────────────────────────────
// SETTINGS MODAL
// ──────────────────────────────────────────────
function openSettingsModal() {
	renderSettingsCategories();
	openModal("modal-settings");

	// Sync theme/accent chips
	document.querySelectorAll(".theme-chip").forEach((c) => {
		c.classList.toggle("active", c.dataset.theme === State.settings.theme);
	});
	document.querySelectorAll(".accent-chip").forEach((c) => {
		c.classList.toggle("active", c.dataset.accent === State.settings.accent);
	});
}

function renderSettingsCategories() {
	const container = document.getElementById("settings-categories");
	if (State.categories.length === 0) {
		container.innerHTML = `<p style="font-size:12.5px;color:var(--text-3)">No categories yet.</p>`;
		return;
	}
	container.innerHTML = State.categories
		.map(
			(cat) => `
    <div class="settings-category-row">
      <span class="category-dot" style="background:${cat.color}"></span>
      <span>${escapeHtml(cat.name)}</span>
      <button data-delete-cat="${cat.id}">Remove</button>
    </div>`,
		)
		.join("");

	container.querySelectorAll("[data-delete-cat]").forEach((btn) => {
		btn.addEventListener("click", () => {
			const id = btn.dataset.deleteCat;
			State.categories = State.categories.filter((c) => c.id !== id);
			// Remove category from metadata
			for (const mid in State.metadata) {
				if (State.metadata[mid].category === id)
					State.metadata[mid].category = "";
			}
			Storage.save();
			renderSettingsCategories();
			renderCategoriesSidebar();
			populateCategorySelect("bm-category");
			populateCategorySelect("detail-category");
		});
	});
}

// ──────────────────────────────────────────────
// TOAST
// ──────────────────────────────────────────────
function toast(message, type = "info") {
	const container = document.getElementById("toast-container");
	const icons = {
		success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M20 6 9 17l-5-5" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
		error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="#ef4444" stroke-width="2"/><path d="M15 9l-6 6M9 9l6 6" stroke="#ef4444" stroke-width="2" stroke-linecap="round"/></svg>`,
		info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="var(--accent)" stroke-width="2"/><path d="M12 8v4M12 16h.01" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>`,
	};
	const el = document.createElement("div");
	el.className = `toast ${type}`;
	el.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
	container.appendChild(el);
	setTimeout(() => {
		el.style.opacity = "0";
		el.style.transform = "translateX(24px)";
		el.style.transition = "0.3s";
		setTimeout(() => el.remove(), 300);
	}, 3000);
}

// ──────────────────────────────────────────────
// EXPORT / IMPORT
// ──────────────────────────────────────────────
function exportData() {
	const data = { metadata: State.metadata, categories: State.categories };
	const blob = new Blob([JSON.stringify(data, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = "bookmarkhub-export.json";
	a.click();
	URL.revokeObjectURL(url);
	toast("Exported successfully", "success");
}

function importData(file) {
	const reader = new FileReader();
	reader.onload = (e) => {
		try {
			const data = JSON.parse(e.target.result);
			if (data.metadata)
				State.metadata = { ...State.metadata, ...data.metadata };
			if (data.categories) State.categories = data.categories;
			Storage.save();
			render();
			toast("Import successful", "success");
		} catch {
			toast("Invalid JSON file", "error");
		}
	};
	reader.readAsText(file);
}

// ──────────────────────────────────────────────
// THEME / ACCENT
// ──────────────────────────────────────────────
function applyTheme() {
	document.documentElement.setAttribute("data-theme", State.settings.theme);
	document.documentElement.setAttribute("data-accent", State.settings.accent);
}

// ──────────────────────────────────────────────
// EVENT LISTENERS
// ──────────────────────────────────────────────
function initEvents() {
	// Sidebar collapse
	document
		.getElementById("btn-collapse-sidebar")
		.addEventListener("click", () => {
			document.getElementById("sidebar").classList.toggle("collapsed");
		});

	// Nav filters
	document.querySelectorAll(".nav-item[data-filter]").forEach((btn) => {
		btn.addEventListener("click", () => {
			State.currentFilter = btn.dataset.filter;
			State.currentFolder = null;
			State.currentTag = null;
			State.currentCategory = null;
			updateNavActive(btn.dataset.filter);
			renderBookmarks();
			renderTagsSidebar();
			renderFoldersTree();
			renderCategoriesSidebar();
			updateActiveFilters();
			updatePageTitle();
		});
	});

	// Search
	const searchInput = document.getElementById("search-input");
	const searchKbd = document.getElementById("search-kbd");
	const searchClear = document.getElementById("btn-clear-search");

	searchInput.addEventListener("input", () => {
		State.searchQuery = searchInput.value;
		searchKbd.classList.toggle("hidden", !!searchInput.value);
		searchClear.classList.toggle("hidden", !searchInput.value);
		renderBookmarks();
		updatePageTitle();
	});

	searchClear.addEventListener("click", () => {
		searchInput.value = "";
		State.searchQuery = "";
		searchKbd.classList.remove("hidden");
		searchClear.classList.add("hidden");
		renderBookmarks();
		updatePageTitle();
		searchInput.focus();
	});

	// Keyboard shortcut "/" to focus search
	document.addEventListener("keydown", (e) => {
		if (e.key === "/" && document.activeElement !== searchInput) {
			e.preventDefault();
			searchInput.focus();
			searchInput.select();
		}
		if (e.key === "Escape") {
			hideContextMenu();
			["modal-bookmark", "modal-detail", "modal-settings"].forEach(
				closeModal,
			);
		}
	});

	// View toggle
	document.getElementById("btn-view-grid").addEventListener("click", () => {
		State.viewMode = "grid";
		document.getElementById("btn-view-grid").classList.add("active");
		document.getElementById("btn-view-list").classList.remove("active");
		renderBookmarks();
	});

	document.getElementById("btn-view-list").addEventListener("click", () => {
		State.viewMode = "list";
		document.getElementById("btn-view-list").classList.add("active");
		document.getElementById("btn-view-grid").classList.remove("active");
		renderBookmarks();
	});

	// Sort
	document.getElementById("sort-select").addEventListener("change", (e) => {
		State.sortMode = e.target.value;
		renderBookmarks();
	});

	// Add bookmark button
	document
		.getElementById("btn-add-bookmark")
		.addEventListener("click", openAddBookmarkModal);

	// Save bookmark
	document
		.getElementById("btn-save-bookmark")
		.addEventListener("click", saveBookmark);

	// Save detail
	document
		.getElementById("btn-save-detail")
		.addEventListener("click", saveDetail);

	// Delete from detail
	document
		.getElementById("btn-delete-bookmark")
		.addEventListener("click", () => {
			if (State.activeBookmarkId) {
				closeModal("modal-detail");
				deleteBookmark(State.activeBookmarkId);
			}
		});

	// Settings
	document
		.getElementById("btn-settings")
		.addEventListener("click", openSettingsModal);

	// Theme chips
	document.querySelectorAll(".theme-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			State.settings.theme = chip.dataset.theme;
			Storage.save();
			applyTheme();
			document
				.querySelectorAll(".theme-chip")
				.forEach((c) => c.classList.toggle("active", c === chip));
		});
	});

	// Accent chips
	document.querySelectorAll(".accent-chip").forEach((chip) => {
		chip.addEventListener("click", () => {
			State.settings.accent = chip.dataset.accent;
			Storage.save();
			applyTheme();
			document
				.querySelectorAll(".accent-chip")
				.forEach((c) => c.classList.toggle("active", c === chip));
		});
	});

	// Add category
	document
		.getElementById("btn-create-category")
		.addEventListener("click", () => {
			const name = document.getElementById("new-category-name").value.trim();
			const color = document.getElementById("new-category-color").value;
			if (!name) {
				toast("Enter a category name", "error");
				return;
			}
			const id = "cat_" + Date.now();
			State.categories.push({ id, name, color });
			Storage.save();
			document.getElementById("new-category-name").value = "";
			renderSettingsCategories();
			renderCategoriesSidebar();
			populateCategorySelect("bm-category");
			populateCategorySelect("detail-category");
			toast(`Category "${name}" created`, "success");
		});

	// Export / Import
	document.getElementById("btn-export").addEventListener("click", exportData);
	document.getElementById("btn-import").addEventListener("click", () => {
		document.getElementById("import-file").click();
	});
	document.getElementById("import-file").addEventListener("change", (e) => {
		if (e.target.files[0]) importData(e.target.files[0]);
	});

	// Modal close buttons
	document.querySelectorAll(".modal-close").forEach((btn) => {
		btn.addEventListener("click", () => closeModal(btn.dataset.modal));
	});

	// Backdrop click to close modals
	document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
		backdrop.addEventListener("click", (e) => {
			if (e.target === backdrop) closeModal(backdrop.id);
		});
	});

	// Context Menu
	document.getElementById("ctx-open").addEventListener("click", () => {
		if (contextTargetId) openBookmark(contextTargetId);
		hideContextMenu();
	});
	document.getElementById("ctx-open-new").addEventListener("click", () => {
		if (contextTargetId) openBookmarkNewTab(contextTargetId);
		hideContextMenu();
	});
	document.getElementById("ctx-edit").addEventListener("click", () => {
		if (contextTargetId) openDetailModal(contextTargetId);
		hideContextMenu();
	});
	document.getElementById("ctx-copy").addEventListener("click", () => {
		if (contextTargetId) {
			const bm = State.allBookmarks.find((b) => b.id === contextTargetId);
			if (bm) {
				navigator.clipboard.writeText(bm.url);
				toast("URL copied", "success");
			}
		}
		hideContextMenu();
	});
	document.getElementById("ctx-delete").addEventListener("click", () => {
		if (contextTargetId) deleteBookmark(contextTargetId);
		hideContextMenu();
	});

	document.addEventListener("click", (e) => {
		if (!e.target.closest("#context-menu")) hideContextMenu();
	});

	// Chrome bookmarks change listeners
	chrome.bookmarks.onCreated.addListener(() => reloadBookmarks());
	chrome.bookmarks.onRemoved.addListener(() => reloadBookmarks());
	chrome.bookmarks.onChanged.addListener(() => reloadBookmarks());
	chrome.bookmarks.onMoved.addListener(() => reloadBookmarks());
}

// ──────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────
async function reloadBookmarks() {
	State.folderTree = await new Promise((res) => chrome.bookmarks.getTree(res));
	State.allBookmarks = flattenBookmarks(State.folderTree);
	render();
}

async function init() {
	await Storage.load();
	applyTheme();
	await reloadBookmarks();
	initEvents();
	// Start with "All Bookmarks" active
	updateNavActive("all");
}

document.addEventListener("DOMContentLoaded", init);
