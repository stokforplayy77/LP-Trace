// Uji logika murni penampil (node:test, tanpa framework). Dijalankan: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	categoryOf,
	consoleEntries,
	consoleLevel,
	filterConsole,
	filterRows,
	groupWaterfall,
	parseTrace,
	parseTraceLine,
	summarize,
	toCSV,
	toHAR
} from '../src/lib/trace.ts';

const EXAMPLE = [
	'{"ts":"2026-10-29T05:44:05.153Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{"cdp":"ws://127.0.0.1:9222"}}',
	'{"ts":"2026-10-29T05:44:06.102Z","mono_ms":949,"seq":2,"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-1","url":"https://example.com/","method":"GET","type":"Document"}}',
	'{"ts":"2026-10-29T05:44:06.610Z","mono_ms":1457,"seq":3,"session":"s1","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"LID-1","url":"https://example.com/","status":200,"mimeType":"text/html"}}',
	'{"ts":"2026-10-29T05:44:07.004Z","mono_ms":1851,"seq":4,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["hello"]}}',
	'{"ts":"2026-10-29T05:44:07.100Z","mono_ms":1947,"seq":5,"session":"s1","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"LID-1"}}',
	'{"ts":"2026-10-29T05:44:07.200Z","mono_ms":2047,"seq":6,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"warning","args":["hati-hati"]}}',
	'{"ts":"2026-10-29T05:44:07.300Z","mono_ms":2147,"seq":7,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"error","args":["gagal total"]}}',
	'{"ts":"2026-10-29T05:44:07.400Z","mono_ms":2247,"seq":8,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.exceptionThrown","data":{"exceptionDetails":{"text":"Uncaught","exception":{"description":"Error: boom"}}}}',
	'{"ts":"2026-10-29T05:44:07.500Z","mono_ms":2347,"seq":9,"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-2","url":"http://127.0.0.1:9/x","method":"GET","type":"Fetch"}}',
	'{"ts":"2026-10-29T05:44:07.600Z","mono_ms":2447,"seq":10,"session":"s1","lightpanda_version":"1.0.2","type":"Network.loadingFailed","data":{"requestId":"LID-2","errorText":"CouldntConnect"}}',
	'{"ts":"2026-10-29T05:44:08.000Z","mono_ms":2847,"seq":11,"session":"s1","lightpanda_version":"1.0.2","type":"tracer.session_ended","data":{}}'
].join('\n');

test('parse: contoh M1 menghasilkan 11 baris, 0 dilewati', () => {
	const { rows, skipped } = parseTrace(EXAMPLE);
	assert.equal(rows.length, 11);
	assert.equal(skipped, 0);
	assert.equal(rows[0].type, 'tracer.session_started');
	assert.equal(rows[0].lightpanda_version, '1.0.2');
});

test('parse: baris rusak dilewati dan dihitung, tidak crash', () => {
	const text = [
		'{"ts":"x","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Page.frameNavigated","data":{}}',
		'ini bukan json',
		'{"type":123,"data":{}}',
		'',
		'[1,2,3]',
		'{"type":"Network.requestWillBeSent","data":{"requestId":"R1"}}'
	].join('\n');
	const { rows, skipped } = parseTrace(text);
	assert.equal(rows.length, 2);
	assert.equal(skipped, 3);
});

test('parseTraceLine: baris kosong dan non-objek -> null', () => {
	assert.equal(parseTraceLine(''), null);
	assert.equal(parseTraceLine('  '), null);
	assert.equal(parseTraceLine('"teks"'), null);
});

test('kategori: tracer/error/konsol/navigasi/network/lainnya', () => {
	assert.equal(categoryOf('tracer.session_started'), 'tracer');
	assert.equal(categoryOf('Runtime.exceptionThrown'), 'error');
	assert.equal(categoryOf('Network.loadingFailed'), 'error');
	assert.equal(categoryOf('Runtime.consoleAPICalled'), 'konsol');
	assert.equal(categoryOf('Page.frameNavigated'), 'navigasi');
	assert.equal(categoryOf('Network.requestWillBeSent'), 'network');
	assert.equal(categoryOf('DOM.documentUpdated'), 'lainnya');
});

test('waterfall: durasi dari mono_ms tracer (bukan timing CDP)', () => {
	const { rows } = parseTrace(EXAMPLE);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 2);
	const ok = entries.find((e) => e.requestId === 'LID-1');
	assert.ok(ok);
	assert.equal(ok.status, '200');
	assert.equal(ok.mimeType, 'text/html');
	assert.equal(ok.timeToResponseMs, 1457 - 949);
	assert.equal(ok.totalMs, 1947 - 949);
	assert.equal(ok.failed, false);
	const failed = entries.find((e) => e.requestId === 'LID-2');
	assert.ok(failed);
	assert.equal(failed.failed, true);
	assert.equal(failed.errorText, 'CouldntConnect');
	assert.equal(failed.totalMs, 2447 - 2347);
	assert.equal(failed.timeToResponseMs, null);
});

test('waterfall: entri tanpa loadingFinished -> totalMs null', () => {
	const { rows } = parseTrace(
		'{"ts":"x","mono_ms":10,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"R9","url":"https://a.test/","method":"GET"}}'
	);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].totalMs, null);
});

test('level konsol: warning dipertahankan; warn dinormalisasi ke warning', () => {
	const { rows } = parseTrace(EXAMPLE);
	const warnRow = parseTraceLine(
		'{"ts":"x","mono_ms":0,"seq":99,"session":"s","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"warn","args":["w"]}}'
	);
	assert.ok(warnRow);
	assert.equal(consoleLevel(warnRow), 'warning');
	const entries = consoleEntries(rows);
	assert.equal(entries.length, 4); // 3 console + 1 exception
	assert.deepEqual(
		entries.map((e) => e.level),
		['log', 'warning', 'error', 'exception']
	);
	assert.equal(entries[3].text, 'Uncaught');
});

test('filter konsol: hanya level yang dipilih', () => {
	const { rows } = parseTrace(EXAMPLE);
	const entries = consoleEntries(rows);
	assert.equal(filterConsole(entries, ['error'], '').length, 1);
	assert.equal(filterConsole(entries, ['log', 'warning'], '').length, 2);
	assert.equal(filterConsole(entries, [], '').length, 4);
	assert.equal(filterConsole(entries, ['exception'], '').length, 1);
});

test('pencarian: cocok pada URL dan pada teks konsol', () => {
	const { rows } = parseTrace(EXAMPLE);
	assert.equal(filterRows(rows, 'example.com', []).length, 2); // request + response
	assert.equal(filterRows(rows, 'gagal total', []).length, 1);
	assert.equal(filterRows(rows, 'tidak-ada-yang-cocok', []).length, 0);
	assert.equal(filterRows(rows, '', []).length, 11);
});

test('filter kategori: hanya kategori terpilih', () => {
	const { rows } = parseTrace(EXAMPLE);
	assert.equal(filterRows(rows, '', ['error']).length, 2); // exception + loadingFailed
	assert.equal(filterRows(rows, '', ['tracer']).length, 2);
});

test('ringkasan: exception memakai teks exceptionDetails', () => {
	const { rows } = parseTrace(EXAMPLE);
	const exc = rows.find((r) => r.type === 'Runtime.exceptionThrown');
	assert.ok(exc);
	assert.equal(summarize(exc), 'Uncaught');
});

test('CSV: header + baris + escaping koma/kutip', () => {
	const { rows } = parseTrace(EXAMPLE);
	const csv = toCSV(rows.slice(0, 2));
	const lines = csv.split('\r\n');
	assert.equal(lines[0], 'seq,ts,mono_ms,session,lightpanda_version,type,ringkasan');
	assert.ok(lines[1].includes('tracer.session_started'));
	const tricky = parseTraceLine(
		'{"ts":"x","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["a, \\"b\\""]}}'
	);
	assert.ok(tricky);
	const csv2 = toCSV([tricky]);
	assert.ok(csv2.includes('""b""'));
});

test('bentuk mentah CDP: url/metode bersarang di request, status di response', () => {
	const { rows } = parseTrace(
		[
			'{"ts":"x","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"R1","type":"Document","request":{"url":"https://a.test/p","method":"POST"}}}',
			'{"ts":"x","mono_ms":50,"seq":2,"session":"s","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"R1","response":{"url":"https://a.test/p","status":201,"mimeType":"application/json"}}}',
			'{"ts":"x","mono_ms":80,"seq":3,"session":"s","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"R1"}}'
		].join('\n')
	);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].url, 'https://a.test/p');
	assert.equal(entries[0].method, 'POST');
	assert.equal(entries[0].status, '201');
	assert.equal(entries[0].mimeType, 'application/json');
	assert.equal(entries[0].totalMs, 80);
	// loadingFinished hanya membawa requestId (tanpa URL), jadi 2 dari 3 baris cocok.
	assert.equal(filterRows(rows, 'a.test/p', []).length, 2);
});

test('HAR: subset best-effort — dns/connect/ssl -1, ukuran -1, ada komentar', () => {
	const { rows } = parseTrace(EXAMPLE);
	const har = toHAR(rows, groupWaterfall(rows));
	const log = har.log;
	assert.ok(log && typeof log === 'object');
	const entries = log.entries;
	assert.ok(Array.isArray(entries));
	assert.equal(entries.length, 2);
	const first = entries[0];
	assert.equal(first.timings.dns, -1);
	assert.equal(first.timings.connect, -1);
	assert.equal(first.timings.ssl, -1);
	assert.equal(first.response.bodySize, -1);
	assert.equal(first.time, 1947 - 949);
	assert.ok(String(log.comment).includes('best-effort'));
});
