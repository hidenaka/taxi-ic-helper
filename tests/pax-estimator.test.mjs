import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { estimatePax } from '../scripts/lib/pax-estimator.mjs';

const seatsMaster = {
  'B789': { name: 'Boeing 787-9', seats: 246 },
  'A359': { name: 'Airbus A350-900', seats: 369 }
};
const factorsMaster = {
  default: 0.70,
  routes: { 'ITM': 0.78, 'OKA': 0.82 }
};

test('機材判明・路線判明で 座席×路線搭乗率', () => {
  const r = estimatePax({ aircraftCode: 'B789', from: 'ITM' }, seatsMaster, factorsMaster);
  assert.equal(r.seatCount, 246);
  assert.equal(r.loadFactor, 0.78);
  assert.equal(r.loadFactorSource, 'route');
  assert.equal(r.estimatedPax, Math.round(246 * 0.78));
});

test('機材判明・路線統計なしで デフォルト搭乗率', () => {
  const r = estimatePax({ aircraftCode: 'B789', from: 'XXX' }, seatsMaster, factorsMaster);
  assert.equal(r.loadFactor, 0.70);
  assert.equal(r.loadFactorSource, 'default');
  assert.equal(r.estimatedPax, Math.round(246 * 0.70));
});

test('機材nullで 全フィールドnull', () => {
  const r = estimatePax({ aircraftCode: null, from: 'ITM' }, seatsMaster, factorsMaster);
  assert.equal(r.seatCount, null);
  assert.equal(r.loadFactor, null);
  assert.equal(r.loadFactorSource, null);
  assert.equal(r.estimatedPax, null);
});

test('機材コードがマスタに存在しない場合も全nullとして扱う', () => {
  const r = estimatePax({ aircraftCode: 'UNKNOWN', from: 'ITM' }, seatsMaster, factorsMaster);
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

// --- ODPT IATA派生コード → ICAO alias マッピングのテスト ---
const fullSeatsMaster = {
  'B77W': { name: 'Boeing 777-300ER', seats: 244 },
  'B788': { name: 'Boeing 787-8', seats: 200 },
  'B789': { name: 'Boeing 787-9', seats: 246 },
  'B763': { name: 'Boeing 767-300', seats: 270 },
  'B738': { name: 'Boeing 737-800', seats: 166 },
  'A320': { name: 'Airbus A320', seats: 146 },
  'A321': { name: 'Airbus A321neo', seats: 194 },
  'A359': { name: 'Airbus A350-900', seats: 369 },
  'A35K': { name: 'Airbus A350-1000', seats: 339 },
  'B772': { name: 'Boeing 777-200', seats: 405 },
  'B773': { name: 'Boeing 777-300', seats: 525 },
  'E90':  { name: 'Embraer E190', seats: 95 },
};

test("ODPT alias '77W' → B77W: 244席 × 0.70 = 171", () => {
  const r = estimatePax({ aircraftCode: '77W', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, 244);
  assert.equal(r.loadFactor, 0.70);
  assert.equal(r.estimatedPax, Math.round(244 * 0.70)); // 171
});

test("ODPT alias '73H' → B738: 166席 × 0.70 = 116", () => {
  const r = estimatePax({ aircraftCode: '73H', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, 166);
  assert.equal(r.estimatedPax, Math.round(166 * 0.70)); // 116
});

test("ODPT alias '78P' → B789: 246席 × 0.70 = 172", () => {
  const r = estimatePax({ aircraftCode: '78P', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, 246);
  assert.equal(r.estimatedPax, Math.round(246 * 0.70)); // 172
});

test("ODPT alias '351' → A35K: 339席 × 0.70 = 237", () => {
  const r = estimatePax({ aircraftCode: '351', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, 339);
  assert.equal(r.estimatedPax, Math.round(339 * 0.70)); // 237
});

test("未知コード 'XYZ' → seatCount = null", () => {
  const r = estimatePax({ aircraftCode: 'XYZ', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

test("aircraftCode が null → seatCount = null", () => {
  const r = estimatePax({ aircraftCode: null, from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

test("ODPT alias '722' → B772: 405席 × 0.70 = 284 (推定マッピング)", () => {
  const r = estimatePax({ aircraftCode: '722', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, 405);
  assert.equal(r.estimatedPax, Math.round(405 * 0.70)); // 284
});

test("ICAO コード 'B789' 直接渡し → alias 経由しなくても seats が取れる", () => {
  const r = estimatePax({ aircraftCode: 'B789', from: 'XXX' }, fullSeatsMaster, factorsMaster);
  assert.equal(r.seatCount, 246);
  assert.equal(r.estimatedPax, Math.round(246 * 0.70));
});

// --- フォールバックチェーン (機材不明 → 便番号辞書 → 路線辞書) ---
const intlSeats = {
  ...fullSeatsMaster,
  'B77W-INT': { name: 'Boeing 777-300ER (国際線仕様)', seats: 264 },
  'B789-INT': { name: 'Boeing 787-9 (国際線仕様)', seats: 215 },
  'B788-INT': { name: 'Boeing 787-8 (国際線仕様)', seats: 184 },
  'A321-INT': { name: 'Airbus A321neo (国際線仕様)', seats: 164 },
};
const fallback = {
  byFlightNumber: { 'NH109': 'B77W-INT', 'NH848': 'B789-INT' },
  byRoute: { 'BKK': 'B789-INT', 'GMP': 'A321-INT' },
};

test('フォールバック: aircraftCode null + 便番号辞書ヒット → 国際線仕様 seatCount', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, 264);
  assert.equal(r.estimatedPax, Math.round(264 * 0.70));
});

test('フォールバック: aircraftCode null + 便番号辞書ミス + 路線辞書ヒット', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH9999', from: 'BKK' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, 215);
  assert.equal(r.estimatedPax, Math.round(215 * 0.70));
});

test('フォールバック: aircraftCode null + 両方ミス → 既存通り null', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH9999', from: 'XXX' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

test('フォールバック: aircraftCode 判明時は辞書を参照しない (回帰)', () => {
  const r = estimatePax(
    { aircraftCode: 'B789', flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster, fallback
  );
  assert.equal(r.seatCount, 246);  // 国内線 B789 (フォールバックの B77W-INT=264 を引かない)
});

test('フォールバック: aircraftFallback 引数なしでも既存動作維持 (互換性)', () => {
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster
  );
  assert.equal(r.seatCount, null);
  assert.equal(r.estimatedPax, null);
});

test('フォールバック: 便番号が辞書の値で seatsMaster ミスなら路線へ進む', () => {
  // byFlightNumber に typo されたコードがあるが seatsMaster にないケース
  const fallbackBad = {
    byFlightNumber: { 'NH109': 'TYPO-CODE' },
    byRoute: { 'JFK': 'B77W-INT' },
  };
  const r = estimatePax(
    { aircraftCode: null, flightNumber: 'NH109', from: 'JFK' },
    intlSeats, factorsMaster, fallbackBad
  );
  assert.equal(r.seatCount, 264);  // 路線フォールバックで救出
});
