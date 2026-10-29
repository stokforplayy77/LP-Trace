// Logika murni penampil trace (tanpa dependensi framework) — dapat diuji
// langsung dengan node:test lewat type stripping Node 24. Skema mengikuti
// Lampiran A Dokumen Perancangan v1.1. Durasi selalu dihitung dari
// stempel waktu tracer (ts / mono_ms), BUKAN dari field timing CDP.

export interface TraceRow {
	seq: number;
	ts: string;
	mono_ms: number;
	session: string;
	lightpanda_version: string;
	type: string;
	data: Record<string, unknown>;
}

export interface ParsedTrace {
	rows: TraceRow[];
	skipped: number;
}

export type Category = 'navigasi' | 'network' | 'konsol' | 'error' | 'tracer' | 'lainnya';

export function categoryOf(type: string): Category {
	if (type.startsWith('tracer.')) return 'tracer';
	if (type === 'Runtime.exceptionThrown' || type === 'Network.loadingFailed') return 'error';
	if (type === 'Runtime.consoleAPICalled') return 'konsol';
	if (type.startsWith('Page.')) return 'navigasi';
	if (type.startsWith('Network.')) return 'network';
	return 'lainnya';
}

/** Satu baris JSONL -> TraceRow, atau null bila baris bukan baris trace valid. */
export function parseTraceLine(line: string): TraceRow | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof obj !== 'object' || obj === null) return null;
	const rec = obj as Record<string, unknown>;
	if (typeof rec.type !== 'string') return null;
	if (typeof rec.data !== 'object' || rec.data === null) return null;
	return {
		seq: typeof rec.seq === 'number' ? rec.seq : 0,
		ts: typeof rec.ts === 'string' ? rec.ts : '',
		mono_ms: typeof rec.mono_ms === 'number' ? rec.mono_ms : 0,
		session: typeof rec.session === 'string' ? rec.session : '',
		lightpanda_version:
			typeof rec.lightpanda_version === 'string' ? rec.lightpanda_version : 'unknown',
		type: rec.type,
		data: rec.data as Record<string, unknown>
	};
}

/** Parse seluruh isi file .jsonl. Baris rusak dilewati dan dihitung, tidak crash. */
export function parseTrace(text: string): ParsedTrace {
	const rows: TraceRow[] = [];
	let skipped = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const row = parseTraceLine(line);
		if (row === null) skipped++;
		else rows.push(row);
	}
	return { rows, skipped };
}

function asString(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined || value === null) return '';
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(value);
	}
}

function nestedRecord(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = data[key];
	if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
	return null;
}

/**
 * Ambil field dari payload CDP apa adanya: langsung di data, atau bersarang
 * di data.request / data.response (bentuk mentah Network.requestWillBeSent
 * dan Network.responseReceived dari Lightpanda). Mengembalikan '' bila
 * tidak ada.
 */
function pickString(data: Record<string, unknown>, key: string): string {
	const direct = data[key];
	if (typeof direct === 'string' && direct) return direct;
	if (typeof direct === 'number') return String(direct);
	for (const nest of ['request', 'response']) {
		const inner = nestedRecord(data, nest);
		if (!inner) continue;
		const value = inner[key];
		if (typeof value === 'string' && value) return value;
		if (typeof value === 'number') return String(value);
	}
	return '';
}

/** URL permintaan: data.url, data.documentURL, atau request/response.url. */
function urlOf(data: Record<string, unknown>): string {
	return pickString(data, 'url') || pickString(data, 'documentURL');
}

/** Ringkasan satu baris untuk timeline/tabel. */
export function summarize(row: TraceRow): string {
	const d = row.data;
	switch (row.type) {
		case 'Page.frameNavigated':
			return urlOf(d) || asString(d.frameId);
		case 'Network.requestWillBeSent':
			return `${pickString(d, 'method') || 'GET'} ${urlOf(d)}`;
		case 'Network.responseReceived': {
			const status = pickString(d, 'status');
			return `${status} ${urlOf(d)}`.trim();
		}
		case 'Network.loadingFinished':
		case 'Network.loadingFailed':
			return `${asString(d.requestId)}${d.errorText ? ` — ${asString(d.errorText)}` : ''}`;
		case 'Runtime.consoleAPICalled': {
			const args = Array.isArray(d.args) ? d.args.map(asString).join(' ') : '';
			return `[${asString(d.type)}] ${args}`;
		}
		case 'Runtime.exceptionThrown': {
			const details = d.exceptionDetails as Record<string, unknown> | undefined;
			return (
				asString(details?.text) ||
				asString(details?.exception && (details.exception as Record<string, unknown>).description) ||
				asString(d.text)
			);
		}
		case 'DOM.documentUpdated':
			return 'dokumen diperbarui (penanda kasar)';
		default:
			if (row.type.startsWith('tracer.')) return asString(d.reason) || asString(d.cdp) || row.type;
			return urlOf(d) || row.type;
	}
}

/** Level konsol sebagaimana diterima dari CDP. CDP memakai "warning", bukan "warn". */
export function consoleLevel(row: TraceRow): string {
	if (row.type === 'Runtime.exceptionThrown') return 'exception';
	const raw = asString(row.data.type).toLowerCase();
	if (raw === 'warn') return 'warning';
	return raw || 'log';
}

export interface ConsoleEntry {
	row: TraceRow;
	level: string;
	text: string;
}

/** Entri Panel Konsol: consoleAPICalled + exceptionThrown, terurut waktu. */
export function consoleEntries(rows: TraceRow[]): ConsoleEntry[] {
	const out: ConsoleEntry[] = [];
	for (const row of rows) {
		if (row.type === 'Runtime.consoleAPICalled') {
			const args = Array.isArray(row.data.args) ? row.data.args.map(asString).join(' ') : '';
			out.push({ row, level: consoleLevel(row), text: args });
		} else if (row.type === 'Runtime.exceptionThrown') {
			out.push({ row, level: 'exception', text: summarize(row) });
		}
	}
	return out;
}

export interface WaterfallEntry {
	requestId: string;
	url: string;
	method: string;
	resourceType: string;
	status: string;
	mimeType: string;
	startMs: number;
	responseMs: number | null;
	endMs: number | null;
	failed: boolean;
	errorText: string;
	/** Durasi total dari stempel waktu tracer (ms), atau null bila belum selesai. */
	totalMs: number | null;
	/** Waktu sampai respons pertama dari stempel waktu tracer (ms). */
	timeToResponseMs: number | null;
}

function requestIdOf(data: Record<string, unknown>): string {
	return asString(data.requestId);
}

/** Kelompokkan event network per requestId; semua durasi dari mono_ms tracer. */
export function groupWaterfall(rows: TraceRow[]): WaterfallEntry[] {
	const map = new Map<string, WaterfallEntry>();
	const order: string[] = [];
	const get = (id: string): WaterfallEntry => {
		let entry = map.get(id);
		if (!entry) {
			entry = {
				requestId: id,
				url: '',
				method: '',
				resourceType: '',
				status: '',
				mimeType: '',
				startMs: 0,
				responseMs: null,
				endMs: null,
				failed: false,
				errorText: '',
				totalMs: null,
				timeToResponseMs: null
			};
			map.set(id, entry);
			order.push(id);
		}
		return entry;
	};
	for (const row of rows) {
		const d = row.data;
		if (row.type === 'Network.requestWillBeSent') {
			const id = requestIdOf(d);
			if (!id) continue;
			const entry = get(id);
			entry.startMs = row.mono_ms;
			entry.url = urlOf(d);
			entry.method = pickString(d, 'method') || 'GET';
			entry.resourceType = asString(d.type) || asString(d.resourceType);
		} else if (row.type === 'Network.responseReceived') {
			const id = requestIdOf(d);
			if (!id) continue;
			const entry = get(id);
			entry.responseMs = row.mono_ms;
			entry.status = pickString(d, 'status');
			entry.mimeType = pickString(d, 'mimeType');
			if (!entry.url) entry.url = urlOf(d);
		} else if (row.type === 'Network.loadingFinished') {
			const id = requestIdOf(d);
			if (!id) continue;
			get(id).endMs = row.mono_ms;
		} else if (row.type === 'Network.loadingFailed') {
			const id = requestIdOf(d);
			if (!id) continue;
			const entry = get(id);
			entry.endMs = row.mono_ms;
			entry.failed = true;
			entry.errorText = asString(d.errorText);
		}
	}
	return order.map((id) => {
		const entry = map.get(id)!;
		entry.timeToResponseMs =
			entry.responseMs !== null ? entry.responseMs - entry.startMs : null;
		entry.totalMs = entry.endMs !== null ? entry.endMs - entry.startMs : null;
		return entry;
	});
}

/** Teks yang dicari: URL + teks konsol + tipe event. */
export function searchableText(row: TraceRow): string {
	const parts = [row.type, summarize(row), urlOf(row.data)];
	if (row.type === 'Runtime.consoleAPICalled' && Array.isArray(row.data.args)) {
		parts.push(row.data.args.map(asString).join(' '));
	}
	return parts.join(' ').toLowerCase();
}

export function filterRows(rows: TraceRow[], query: string, categories: Category[]): TraceRow[] {
	const q = query.trim().toLowerCase();
	return rows.filter((row) => {
		if (categories.length > 0 && !categories.includes(categoryOf(row.type))) return false;
		if (q && !searchableText(row).includes(q)) return false;
		return true;
	});
}

export function filterConsole(
	entries: ConsoleEntry[],
	levels: string[],
	query: string
): ConsoleEntry[] {
	const q = query.trim().toLowerCase();
	return entries.filter((entry) => {
		if (levels.length > 0 && !levels.includes(entry.level)) return false;
		if (q) {
			const hay = `${entry.level} ${entry.text} ${entry.row.type}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	});
}

function csvCell(value: string): string {
	if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
	return value;
}

/** CSV dari baris yang sedang ditampilkan (hasil filter saat ini). */
export function toCSV(rows: TraceRow[]): string {
	const header = ['seq', 'ts', 'mono_ms', 'session', 'lightpanda_version', 'type', 'ringkasan'];
	const lines = [header.join(',')];
	for (const row of rows) {
		lines.push(
			[
				String(row.seq),
				row.ts,
				String(row.mono_ms),
				row.session,
				row.lightpanda_version,
				row.type,
				summarize(row)
			]
				.map(csvCell)
				.join(',')
		);
	}
	return lines.join('\r\n') + '\r\n';
}

/**
 * HAR subset best-effort: durasi dari stempel waktu tracer, TANPA breakdown
 * DNS/TLS dan TANPA ukuran byte (datanya tidak tersedia dari CDP).
 * Konsumen HAR tidak boleh mengartikan angka ini sebagai breakdown jaringan.
 */
export function toHAR(rows: TraceRow[], entries: WaterfallEntry[]): Record<string, unknown> {
	const first = rows[0];
	const started = first?.ts || new Date(0).toISOString();
	return {
		log: {
			version: '1.2',
			creator: { name: 'lp-trace-viewer', version: '0.1.0' },
			comment:
				'subset best-effort: durasi dari stempel waktu tracer; tanpa breakdown DNS/TLS dan tanpa ukuran byte.',
			pages: [
				{
					startedDateTime: started,
					id: 'page_1',
					title: first?.session || 'trace',
					pageTimings: { onContentLoad: -1, onLoad: -1 }
				}
			],
			entries: entries.map((entry) => {
				const total = entry.totalMs ?? 0;
				const wait = entry.timeToResponseMs ?? 0;
				return {
					startedDateTime: started,
					time: total,
					request: {
						method: entry.method || 'GET',
						url: entry.url,
						httpVersion: 'HTTP/1.1',
						headers: [],
						queryString: [],
						cookies: [],
						headersSize: -1,
						bodySize: -1
					},
					response: {
						status: entry.status ? Number(entry.status) : 0,
						statusText: entry.failed ? entry.errorText : '',
						httpVersion: 'HTTP/1.1',
						headers: [],
						cookies: [],
						content: { size: -1, mimeType: entry.mimeType || '' },
						redirectURL: '',
						headersSize: -1,
						bodySize: -1
					},
					cache: {},
					timings: {
						blocked: 0,
						dns: -1,
						connect: -1,
						send: 0,
						wait,
						receive: Math.max(0, total - wait),
						ssl: -1
					},
					comment: 'Durasi dari stempel waktu tracer; dns/connect/ssl -1 = tidak tersedia.'
				};
			})
		}
	};
}

/** Waktu relatif dalam detik terhadap baris pertama, 3 desimal. */
export function relativeSeconds(rows: TraceRow[], row: TraceRow): number {
	if (rows.length === 0) return 0;
	return (row.mono_ms - rows[0].mono_ms) / 1000;
}

export function formatSeconds(value: number): string {
	return `${value.toFixed(3)} dtk`;
}
