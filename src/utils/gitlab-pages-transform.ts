/**
 * Pure transforms that convert Obsidian-flavored markdown into a form
 * that renders correctly on GitLab Pages.
 *
 * No Obsidian or Node imports — these functions are deliberately pure so
 * they can be unit tested in isolation. The Obsidian-aware glue (resolving
 * a wiki-link name to a real file, copying assets, etc.) lives in
 * src/core/pages-compat-pipeline.ts and is injected via the resolver
 * callbacks.
 */

export interface ImageResolver {
	/**
	 * Resolve an Obsidian image embed name (e.g. "diagram.png" or
	 * "subdir/diagram.png") to a path that should appear in the rewritten
	 * markdown. The path should be relative to the markdown file that
	 * contained the embed.
	 *
	 * Return null if the image cannot be resolved — the original embed
	 * will be left in place and a warning logged by the caller.
	 */
	(linkName: string, sourceMdPath: string): string | null;
}

export interface WikiLinkResolver {
	/**
	 * Resolve an Obsidian wiki link target (e.g. "Other Note" or
	 * "folder/Other Note") to a path relative to the source md file.
	 * Return null to leave the link untouched.
	 */
	(linkTarget: string, sourceMdPath: string): string | null;
}

export interface TransformOptions {
	transformImages?: boolean;
	transformWikiLinks?: boolean;
	transformCallouts?: boolean;
}

export interface TransformWarning {
	kind: 'image-unresolved' | 'wikilink-unresolved';
	target: string;
	sourcePath: string;
}

export interface TransformResult {
	content: string;
	warnings: TransformWarning[];
}

// ---------- helpers ----------

const CODE_FENCE_RE = /(^|\n)(```[\s\S]*?\n```|~~~[\s\S]*?\n~~~)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/**
 * Run a transform on `text` while leaving fenced code blocks and inline code
 * untouched. We protect those regions by swapping them out for placeholders
 * before applying `fn`, then swapping them back.
 */
function withCodeProtected(text: string, fn: (s: string) => string): string {
	const stash: string[] = [];
	const placeholder = (i: number) => `\u0000CODE${i}\u0000`;

	let protectedText = text.replace(CODE_FENCE_RE, (m, lead, block) => {
		stash.push(block);
		return lead + placeholder(stash.length - 1);
	});
	protectedText = protectedText.replace(INLINE_CODE_RE, (m) => {
		stash.push(m);
		return placeholder(stash.length - 1);
	});

	const transformed = fn(protectedText);

	return transformed.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => stash[Number(idx)] ?? '');
}

// ---------- image discovery (pure, used by the move pipeline) ----------

/**
 * Walk the markdown and return the unique list of image link names that
 * point at vault-local files (i.e. not external URLs). Both Obsidian
 * embeds (`![[name]]`) and standard markdown images (`![](name)`) are
 * scanned. Code fences and inline code are skipped via `withCodeProtected`.
 *
 * Used by the GitLab Pages compat pipeline to know which assets to move
 * into the repo *before* running the actual transform pass. The function
 * is pure and lives here so it can be unit-tested in isolation.
 */
export function collectImageLinkNames(md: string): string[] {
	const seen = new Set<string>();

	// Reuse withCodeProtected by running a no-op transform that just
	// records matches inside the protected text.
	withCodeProtected(md, (text) => {
		text.replace(IMAGE_EMBED_RE, (_full, target: string) => {
			const name = String(target).trim();
			if (name) seen.add(name);
			return _full;
		});
		text.replace(MD_IMAGE_RE, (_full, _alt: string, url: string) => {
			if (!url || isExternalUrl(url)) return _full;
			let pathPart = url;
			const hashIdx = pathPart.search(/[#?]/);
			if (hashIdx >= 0) pathPart = pathPart.slice(0, hashIdx);
			let decoded: string;
			try {
				decoded = decodeURIComponent(pathPart);
			} catch {
				decoded = pathPart;
			}
			if (decoded) seen.add(decoded);
			return _full;
		});
		return text;
	});

	return Array.from(seen);
}

// ---------- image embeds ----------

// Matches ![[target]] or ![[target|piece1]] or ![[target|piece1|piece2]]
// Pipe-separated pieces may be: alt text or width (digits, or WIDTHxHEIGHT).
const IMAGE_EMBED_RE = /!\[\[([^\]\n|]+)((?:\|[^\]\n|]*)*)\]\]/g;

const WIDTH_ONLY_RE = /^\d+$/;
const WIDTH_HEIGHT_RE = /^(\d+)x(\d+)$/i;

interface ParsedEmbedPieces {
	alt?: string;
	width?: number;
	height?: number;
}

function parseEmbedPieces(pipeSection: string): ParsedEmbedPieces {
	const result: ParsedEmbedPieces = {};
	if (!pipeSection) return result;
	const pieces = pipeSection.split('|').slice(1); // first is empty
	for (const piece of pieces) {
		const trimmed = piece.trim();
		if (!trimmed) continue;
		const wh = trimmed.match(WIDTH_HEIGHT_RE);
		if (wh) {
			result.width = Number(wh[1]);
			result.height = Number(wh[2]);
			continue;
		}
		if (WIDTH_ONLY_RE.test(trimmed)) {
			result.width = Number(trimmed);
			continue;
		}
		// Anything else is alt text. Last alt wins.
		result.alt = trimmed;
	}
	return result;
}

function escapeHtmlAttr(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeMdLinkText(s: string): string {
	return s.replace(/[\[\]]/g, '\\$&');
}

function escapeMdUrl(s: string): string {
	// Encode spaces and parentheses so they survive markdown link parsing.
	return s.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function transformImageEmbeds(
	md: string,
	resolver: ImageResolver,
	sourceMdPath: string,
	warnings: TransformWarning[],
): string {
	return withCodeProtected(md, (text) =>
		text.replace(IMAGE_EMBED_RE, (full, target: string, pipeSection: string) => {
			const linkName = target.trim();
			const resolved = resolver(linkName, sourceMdPath);
			if (resolved == null) {
				warnings.push({ kind: 'image-unresolved', target: linkName, sourcePath: sourceMdPath });
				return full;
			}
			const pieces = parseEmbedPieces(pipeSection);
			const url = escapeMdUrl(resolved);
			if (pieces.width != null || pieces.height != null) {
				const altAttr = pieces.alt ? ` alt="${escapeHtmlAttr(pieces.alt)}"` : '';
				const widthAttr = pieces.width != null ? ` width="${pieces.width}"` : '';
				const heightAttr = pieces.height != null ? ` height="${pieces.height}"` : '';
				return `<img src="${escapeHtmlAttr(resolved)}"${altAttr}${widthAttr}${heightAttr} />`;
			}
			const alt = pieces.alt ?? '';
			return `![${escapeMdLinkText(alt)}](${url})`;
		}),
	);
}

// ---------- standard markdown image links ----------

// Matches ![alt](url) or ![alt](url "title"). The URL is captured as the
// first non-space run after `(`, which is a pragmatic match for the kinds
// of paths Obsidian writes when "Use [[Wikilinks]]" is OFF (no spaces;
// spaces are %20-encoded by Obsidian itself on insertion).
const MD_IMAGE_RE = /!\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+"([^"\n]*)")?\s*\)/g;

function isExternalUrl(url: string): boolean {
	// Protocol-relative, absolute, data URIs, in-page anchors, or root-relative
	// (which the user has presumably set deliberately for a Pages base URL).
	return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(url);
}

export function transformMarkdownImageLinks(
	md: string,
	resolver: ImageResolver,
	sourceMdPath: string,
	warnings: TransformWarning[],
): string {
	return withCodeProtected(md, (text) =>
		text.replace(MD_IMAGE_RE, (full, alt: string, url: string, title: string | undefined) => {
			if (!url || isExternalUrl(url)) return full;
			// Drop any #fragment / ?query before resolving on disk.
			let pathPart = url;
			let suffix = '';
			const hashIdx = pathPart.search(/[#?]/);
			if (hashIdx >= 0) {
				suffix = pathPart.slice(hashIdx);
				pathPart = pathPart.slice(0, hashIdx);
			}
			// Decode percent-encoded characters so the resolver sees the real
			// filename (Obsidian writes `Pasted%20image.png` etc.).
			let decoded: string;
			try {
				decoded = decodeURIComponent(pathPart);
			} catch {
				decoded = pathPart;
			}

			const resolved = resolver(decoded, sourceMdPath);
			if (resolved == null) {
				// Not in the vault — leave it alone. Don't warn: this is the
				// common case for already-correct relative paths the user wrote
				// by hand.
				return full;
			}

			// If the resolver returned the same path the author already wrote,
			// nothing to do.
			if (resolved === decoded) return full;

			const newUrl = escapeMdUrl(resolved) + suffix;
			const titlePart = title ? ` "${title}"` : '';
			return `![${alt}](${newUrl}${titlePart})`;
		}),
	);
}

// ---------- wiki links ----------

// Matches [[target]] or [[target|alias]]. Lookbehind avoids matching
// image embeds (![[...]]), which were already handled above.
const WIKI_LINK_RE = /(^|[^!])\[\[([^\]\n|]+)(?:\|([^\]\n]*))?\]\]/g;

export function transformWikiLinks(
	md: string,
	resolver: WikiLinkResolver,
	sourceMdPath: string,
	warnings: TransformWarning[],
): string {
	return withCodeProtected(md, (text) =>
		text.replace(WIKI_LINK_RE, (_full, lead: string, target: string, alias: string | undefined) => {
			const trimmedTarget = target.trim();
			// Split off optional #heading or #^block-id
			const hashIdx = trimmedTarget.indexOf('#');
			const baseTarget = hashIdx >= 0 ? trimmedTarget.slice(0, hashIdx) : trimmedTarget;
			const fragment = hashIdx >= 0 ? trimmedTarget.slice(hashIdx) : '';

			const resolved = baseTarget ? resolver(baseTarget, sourceMdPath) : '';
			if (baseTarget && resolved == null) {
				warnings.push({ kind: 'wikilink-unresolved', target: baseTarget, sourcePath: sourceMdPath });
				return _full;
			}
			const display = (alias?.trim() || trimmedTarget).trim();
			const urlBase = resolved ?? '';
			const fragmentForUrl = fragment ? '#' + slugifyHeading(fragment.slice(1)) : '';
			const url = escapeMdUrl(urlBase) + fragmentForUrl;
			return `${lead}[${escapeMdLinkText(display)}](${url})`;
		}),
	);
}

function slugifyHeading(heading: string): string {
	// Match GitLab/GFM heading anchor rules well enough for typical cases.
	return heading
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/\s+/g, '-');
}

// ---------- callouts ----------

const CALLOUT_HEADER_RE = /^>\s*\[!([a-zA-Z]+)\][+-]?\s*(.*)$/;

interface CalloutStyle {
	icon: string;
	label: string;
}

const CALLOUT_STYLES: Record<string, CalloutStyle> = {
	note: { icon: 'ℹ️', label: 'Note' },
	info: { icon: 'ℹ️', label: 'Info' },
	tip: { icon: '💡', label: 'Tip' },
	hint: { icon: '💡', label: 'Hint' },
	important: { icon: '❗', label: 'Important' },
	warning: { icon: '⚠️', label: 'Warning' },
	caution: { icon: '⚠️', label: 'Caution' },
	danger: { icon: '⛔', label: 'Danger' },
	error: { icon: '⛔', label: 'Error' },
	bug: { icon: '🐛', label: 'Bug' },
	success: { icon: '✅', label: 'Success' },
	check: { icon: '✅', label: 'Success' },
	done: { icon: '✅', label: 'Done' },
	question: { icon: '❓', label: 'Question' },
	help: { icon: '❓', label: 'Help' },
	faq: { icon: '❓', label: 'FAQ' },
	example: { icon: '📋', label: 'Example' },
	quote: { icon: '💬', label: 'Quote' },
	cite: { icon: '💬', label: 'Quote' },
	abstract: { icon: '📄', label: 'Abstract' },
	summary: { icon: '📄', label: 'Summary' },
	tldr: { icon: '📄', label: 'TL;DR' },
	todo: { icon: '📝', label: 'Todo' },
};

const DEFAULT_CALLOUT_STYLE: CalloutStyle = { icon: '📝', label: 'Note' };

export function transformCallouts(md: string): string {
	// Walk line by line. We don't need to protect code blocks here
	// because callouts only ever appear at the start of a line as a
	// blockquote, and code fences are already block-level.
	const lines = md.split('\n');
	const out: string[] = [];

	let inFence = false;
	let fenceMarker = '';

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// Track fenced code blocks so we don't rewrite inside them.
		const fenceMatch = line.match(/^(```|~~~)/);
		if (fenceMatch) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fenceMatch[1];
			} else if (line.startsWith(fenceMarker)) {
				inFence = false;
				fenceMarker = '';
			}
			out.push(line);
			continue;
		}
		if (inFence) {
			out.push(line);
			continue;
		}

		const header = line.match(CALLOUT_HEADER_RE);
		if (!header) {
			out.push(line);
			continue;
		}

		const kind = header[1].toLowerCase();
		const title = header[2].trim();
		const style = CALLOUT_STYLES[kind] ?? DEFAULT_CALLOUT_STYLE;
		const heading = title ? `${style.icon} **${style.label} — ${title}**` : `${style.icon} **${style.label}**`;
		out.push(`> ${heading}`);
		out.push('>');
	}

	return out.join('\n');
}

// ---------- top-level ----------

export function applyTransforms(
	md: string,
	opts: TransformOptions,
	resolvers: { image: ImageResolver; wikiLink: WikiLinkResolver },
	sourceMdPath: string,
): TransformResult {
	const warnings: TransformWarning[] = [];
	let out = md;

	// Order matters: image embeds must run before wiki links so the
	// wiki-link regex doesn't accidentally consume them.
	if (opts.transformImages !== false) {
		out = transformImageEmbeds(out, resolvers.image, sourceMdPath, warnings);
		out = transformMarkdownImageLinks(out, resolvers.image, sourceMdPath, warnings);
	}
	if (opts.transformWikiLinks !== false) {
		out = transformWikiLinks(out, resolvers.wikiLink, sourceMdPath, warnings);
	}
	if (opts.transformCallouts !== false) {
		out = transformCallouts(out);
	}

	return { content: out, warnings };
}
