/**
 * data/region-climate.js
 * §100 Climate normals for the four regions, by baseball-calendar month
 * (March–November). Modelled on real climates so the weather feels right:
 *   north — Great Lakes / upper Midwest (Chicago, Minneapolis)
 *   south — Gulf Coast (Houston, New Orleans)
 *   east  — Mid-Atlantic / New England coast (Philadelphia, Boston)
 *   west  — high desert / Front Range (Denver, Salt Lake City, a touch of Phoenix)
 *
 * Per month (values are for the middle of the month; days in between are
 * interpolated):
 *   hi, lo   — normal daily high / low, °F, at our ballpark
 *   dew      — normal dew point, °F
 *   wet      — chance a given day has measurable rain or snow at a point
 *   storms   — share of wet days that are thunderstorm days (vs steady rain)
 *   steer    — speed weather systems move, km/h (jet stream: fast in spring
 *              and fall, slow in midsummer)
 *   wind     — normal surface wind, mph
 *
 * Region-wide extras:
 *   gradientF   — °F colder per 100 km north of our park
 *   waterCalm   — how much big water evens out temperatures near the shore
 *   reliefF     — °F colder over high ground (mountains, mesas)
 *   lakeEffect  — lake-effect rain/snow downwind of big lakes in cold months
 *   seaBreeze   — afternoon storms along the coast in summer
 *   monsoon     — late-summer afternoon storms over high ground
 */

const M = (hi, lo, dew, wet, storms, steer, wind) => ({ hi, lo, dew, wet, storms, steer, wind });

export const CLIMATE_MONTHS = Object.freeze(['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov']);
export const CLIMATE_FIRST_MONTH = 2;   // March, 0-based

export const REGION_CLIMATE = Object.freeze({
  north: {
    months: [
      M(46, 29, 25, 0.35, 0.10, 55, 11),
      M(59, 39, 35, 0.38, 0.25, 50, 11),
      M(70, 49, 46, 0.38, 0.40, 45, 10),
      M(80, 59, 57, 0.35, 0.55, 40, 9),
      M(84, 64, 62, 0.32, 0.60, 35, 8),
      M(82, 63, 61, 0.32, 0.55, 35, 8),
      M(75, 54, 53, 0.30, 0.40, 40, 9),
      M(62, 42, 41, 0.32, 0.20, 48, 10),
      M(48, 32, 30, 0.33, 0.05, 55, 11),
    ],
    gradientF: 1.6, waterCalm: 0.35, reliefF: 0, lakeEffect: true, seaBreeze: false, monsoon: false,
  },
  south: {
    months: [
      M(72, 52, 52, 0.28, 0.40, 45, 9),
      M(79, 59, 59, 0.27, 0.50, 40, 9),
      M(86, 67, 66, 0.28, 0.60, 32, 8),
      M(91, 73, 71, 0.35, 0.75, 22, 7),
      M(93, 75, 73, 0.40, 0.80, 18, 6),
      M(93, 75, 73, 0.40, 0.80, 18, 6),
      M(89, 70, 69, 0.32, 0.65, 22, 7),
      M(81, 60, 58, 0.25, 0.40, 35, 8),
      M(71, 51, 50, 0.27, 0.30, 42, 9),
    ],
    gradientF: 0.9, waterCalm: 0.30, reliefF: 0, lakeEffect: false, seaBreeze: true, monsoon: false,
  },
  east: {
    months: [
      M(52, 34, 28, 0.36, 0.10, 55, 11),
      M(63, 43, 38, 0.38, 0.20, 50, 10),
      M(73, 53, 50, 0.38, 0.35, 42, 9),
      M(82, 63, 60, 0.35, 0.45, 38, 8),
      M(87, 68, 65, 0.33, 0.50, 32, 8),
      M(85, 67, 64, 0.32, 0.45, 32, 8),
      M(78, 60, 57, 0.30, 0.35, 38, 8),
      M(67, 48, 45, 0.30, 0.15, 45, 9),
      M(56, 39, 35, 0.33, 0.05, 52, 10),
    ],
    gradientF: 1.4, waterCalm: 0.40, reliefF: 0, lakeEffect: false, seaBreeze: true, monsoon: false,
  },
  west: {
    months: [
      M(55, 28, 18, 0.20, 0.05, 55, 11),
      M(62, 35, 22, 0.22, 0.15, 55, 12),
      M(72, 44, 32, 0.22, 0.35, 45, 11),
      M(83, 53, 36, 0.15, 0.40, 38, 10),
      M(90, 60, 45, 0.20, 0.70, 30, 9),
      M(88, 58, 45, 0.22, 0.70, 30, 9),
      M(79, 49, 36, 0.15, 0.40, 38, 9),
      M(66, 37, 26, 0.15, 0.10, 45, 10),
      M(52, 26, 20, 0.17, 0.02, 52, 10),
    ],
    gradientF: 1.2, waterCalm: 0.20, reliefF: 9, lakeEffect: false, seaBreeze: false, monsoon: true,
  },
});
