/**
 * FlyDubai FZ1073 (30 Sep 2026) curated ADS-B reconstruction track.
 *
 * Derived from Flightradar24 public playback for flightId 41e663ed
 * (A6-FKF / 8965D1, DXB→divert TUU). GodsEye original layer code —
 * does not copy third-party application source. Inspiration:
 * Bilawal Sidhu Instagram God's Eye View FPV (https://www.instagram.com/p/Dd-rUTuPFB1/).
 * Track points are a curated downsample for globe polyline + shorts FPV hops;
 * not a full FR24 dump redistributed as a product feed.
 */

export const FZ1073_LAYER_ID = 'fz1073-2026';
export const FZ1073_FLIGHT = 'FZ1073';
export const FZ1073_AIRCRAFT = 'A6-FKF';
export const FZ1073_DATE_UTC = '2026-09-30';
export const FZ1073_PEAK_VS_FPM = -30976;
export const FZ1073_FT_TO_M = 0.3048;

/** @typedef {{ t: number, lat: number, lon: number, alt_ft: number, gs_kts: number, vs_fpm: number, hdg: number }} Fz1073Point */

/** @type {readonly Fz1073Point[]} */
export const FZ1073_TRACK = Object.freeze([
  Object.freeze({ t: 1790736592, lat: 25.263597, lon: 55.343006, alt_ft: 0, gs_kts: 2, vs_fpm: 0, hdg: 33 }),
  Object.freeze({ t: 1790736665, lat: 25.262878, lon: 55.34256, alt_ft: 0, gs_kts: 2, vs_fpm: 0, hdg: 33 }),
  Object.freeze({ t: 1790736761, lat: 25.26305, lon: 55.341709, alt_ft: 0, gs_kts: 3, vs_fpm: 0, hdg: 154 }),
  Object.freeze({ t: 1790737022, lat: 25.26347, lon: 55.341503, alt_ft: 0, gs_kts: 7, vs_fpm: 0, hdg: 137 }),
  Object.freeze({ t: 1790737049, lat: 25.262535, lon: 55.341999, alt_ft: 0, gs_kts: 10, vs_fpm: 0, hdg: 120 }),
  Object.freeze({ t: 1790737082, lat: 25.261456, lon: 55.343941, alt_ft: 0, gs_kts: 16, vs_fpm: 0, hdg: 120 }),
  Object.freeze({ t: 1790737115, lat: 25.259926, lon: 55.346691, alt_ft: 0, gs_kts: 20, vs_fpm: 0, hdg: 120 }),
  Object.freeze({ t: 1790737148, lat: 25.258326, lon: 55.349575, alt_ft: 0, gs_kts: 15, vs_fpm: 0, hdg: 120 }),
  Object.freeze({ t: 1790737170, lat: 25.258472, lon: 55.350674, alt_ft: 0, gs_kts: 12, vs_fpm: 0, hdg: 30 }),
  Object.freeze({ t: 1790737199, lat: 25.260117, lon: 55.351776, alt_ft: 0, gs_kts: 15, vs_fpm: 0, hdg: 30 }),
  Object.freeze({ t: 1790737236, lat: 25.260624, lon: 55.353992, alt_ft: 0, gs_kts: 21, vs_fpm: 0, hdg: 120 }),
  Object.freeze({ t: 1790737374, lat: 25.251137, lon: 55.371094, alt_ft: 0, gs_kts: 0, vs_fpm: 0, hdg: 120 }),
  Object.freeze({ t: 1790737568, lat: 25.282242, lon: 55.318859, alt_ft: 1525, gs_kts: 211, vs_fpm: 832, hdg: 301 }),
  Object.freeze({ t: 1790737606, lat: 25.297789, lon: 55.277969, alt_ft: 2225, gs_kts: 251, vs_fpm: 1664, hdg: 278 }),
  Object.freeze({ t: 1790737630, lat: 25.299316, lon: 55.245056, alt_ft: 2950, gs_kts: 266, vs_fpm: 2560, hdg: 273 }),
  Object.freeze({ t: 1790737713, lat: 25.305052, lon: 55.130173, alt_ft: 5675, gs_kts: 298, vs_fpm: 576, hdg: 273 }),
  Object.freeze({ t: 1790737876, lat: 25.319157, lon: 54.838463, alt_ft: 9925, gs_kts: 373, vs_fpm: 1856, hdg: 273 }),
  Object.freeze({ t: 1790738043, lat: 25.340477, lon: 54.510273, alt_ft: 14950, gs_kts: 396, vs_fpm: 1856, hdg: 284 }),
  Object.freeze({ t: 1790738305, lat: 25.478226, lon: 53.970131, alt_ft: 21150, gs_kts: 433, vs_fpm: 1472, hdg: 284 }),
  Object.freeze({ t: 1790738685, lat: 25.679672, lon: 53.123066, alt_ft: 28650, gs_kts: 451, vs_fpm: 1088, hdg: 284 }),
  Object.freeze({ t: 1790738939, lat: 25.90155, lon: 52.598652, alt_ft: 32000, gs_kts: 438, vs_fpm: 64, hdg: 297 }),
  Object.freeze({ t: 1790739317, lat: 26.240891, lon: 51.834023, alt_ft: 32000, gs_kts: 440, vs_fpm: 0, hdg: 295 }),
  Object.freeze({ t: 1790739696, lat: 26.532394, lon: 51.041756, alt_ft: 32000, gs_kts: 436, vs_fpm: 0, hdg: 289 }),
  Object.freeze({ t: 1790740074, lat: 26.770111, lon: 50.230476, alt_ft: 32000, gs_kts: 440, vs_fpm: 0, hdg: 288 }),
  Object.freeze({ t: 1790740455, lat: 27.014961, lon: 49.409477, alt_ft: 32000, gs_kts: 440, vs_fpm: 0, hdg: 294 }),
  Object.freeze({ t: 1790740753, lat: 27.312653, lon: 48.811687, alt_ft: 32000, gs_kts: 444, vs_fpm: 0, hdg: 299 }),
  Object.freeze({ t: 1790741131, lat: 27.69104, lon: 48.044533, alt_ft: 32000, gs_kts: 446, vs_fpm: 0, hdg: 298 }),
  Object.freeze({ t: 1790741512, lat: 27.992706, lon: 47.247337, alt_ft: 34000, gs_kts: 432, vs_fpm: 0, hdg: 289 }),
  Object.freeze({ t: 1790741893, lat: 28.251389, lon: 46.439316, alt_ft: 34000, gs_kts: 430, vs_fpm: 0, hdg: 290 }),
  Object.freeze({ t: 1790742273, lat: 28.53392, lon: 45.640903, alt_ft: 34000, gs_kts: 432, vs_fpm: 0, hdg: 292 }),
  Object.freeze({ t: 1790742653, lat: 28.823517, lon: 44.846245, alt_ft: 34000, gs_kts: 428, vs_fpm: 0, hdg: 292 }),
  Object.freeze({ t: 1790742884, lat: 29.069916, lon: 44.404469, alt_ft: 34000, gs_kts: 433, vs_fpm: 0, hdg: 304 }),
  Object.freeze({ t: 1790743265, lat: 29.502823, lon: 43.692997, alt_ft: 34000, gs_kts: 427, vs_fpm: 0, hdg: 304 }),
  Object.freeze({ t: 1790743378, lat: 29.618774, lon: 43.475964, alt_ft: 34000, gs_kts: 417, vs_fpm: 0, hdg: 282 }),
  Object.freeze({ t: 1790743404, lat: 29.623377, lon: 43.418724, alt_ft: 34000, gs_kts: 416, vs_fpm: 0, hdg: 273 }),
  Object.freeze({ t: 1790743755, lat: 29.656057, lon: 42.642677, alt_ft: 34000, gs_kts: 419, vs_fpm: 0, hdg: 272 }),
  Object.freeze({ t: 1790744138, lat: 29.686249, lon: 41.788876, alt_ft: 34000, gs_kts: 419, vs_fpm: 0, hdg: 272 }),
  Object.freeze({ t: 1790744517, lat: 29.710602, lon: 40.957085, alt_ft: 34000, gs_kts: 412, vs_fpm: 0, hdg: 271 }),
  Object.freeze({ t: 1790744899, lat: 29.72975, lon: 40.114639, alt_ft: 34000, gs_kts: 418, vs_fpm: 0, hdg: 271 }),
  Object.freeze({ t: 1790745277, lat: 29.743423, lon: 39.281193, alt_ft: 34000, gs_kts: 412, vs_fpm: 0, hdg: 270 }),
  Object.freeze({ t: 1790745593, lat: 29.750744, lon: 38.594593, alt_ft: 34000, gs_kts: 411, vs_fpm: 0, hdg: 270 }),
  Object.freeze({ t: 1790745625, lat: 29.751348, lon: 38.522484, alt_ft: 34000, gs_kts: 412, vs_fpm: 0, hdg: 270 }),
  Object.freeze({ t: 1790745656, lat: 29.751955, lon: 38.453979, alt_ft: 34000, gs_kts: 413, vs_fpm: 0, hdg: 270 }),
  Object.freeze({ t: 1790745688, lat: 29.752762, lon: 38.385017, alt_ft: 33250, gs_kts: 432, vs_fpm: -2752, hdg: 271 }),
  Object.freeze({ t: 1790745708, lat: 29.754089, lon: 38.338745, alt_ft: 33225, gs_kts: 387, vs_fpm: -24512, hdg: 270 }),
  Object.freeze({ t: 1790745745, lat: 29.797119, lon: 38.294483, alt_ft: 18925, gs_kts: 502, vs_fpm: -30976, hdg: 26 }),
  Object.freeze({ t: 1790745751, lat: 29.810715, lon: 38.308376, alt_ft: 17550, gs_kts: 585, vs_fpm: -14464, hdg: 47 }),
  Object.freeze({ t: 1790745753, lat: 29.81424, lon: 38.313236, alt_ft: 17150, gs_kts: 594, vs_fpm: -12224, hdg: 50 }),
  Object.freeze({ t: 1790745756, lat: 29.817919, lon: 38.318806, alt_ft: 16850, gs_kts: 598, vs_fpm: -8896, hdg: 52 }),
  Object.freeze({ t: 1790745758, lat: 29.821596, lon: 38.324837, alt_ft: 16675, gs_kts: 598, vs_fpm: -5184, hdg: 54 }),
  Object.freeze({ t: 1790745760, lat: 29.824356, lon: 38.329502, alt_ft: 16600, gs_kts: 593, vs_fpm: -1792, hdg: 56 }),
  Object.freeze({ t: 1790745762, lat: 29.827103, lon: 38.334255, alt_ft: 16650, gs_kts: 593, vs_fpm: -896, hdg: 56 }),
  Object.freeze({ t: 1790745764, lat: 29.831131, lon: 38.341175, alt_ft: 16825, gs_kts: 582, vs_fpm: 4992, hdg: 56 }),
  Object.freeze({ t: 1790745766, lat: 29.834166, lon: 38.346107, alt_ft: 17025, gs_kts: 567, vs_fpm: 5696, hdg: 54 }),
  Object.freeze({ t: 1790745768, lat: 29.837332, lon: 38.350796, alt_ft: 17325, gs_kts: 555, vs_fpm: 7680, hdg: 52 }),
  Object.freeze({ t: 1790745771, lat: 29.84152, lon: 38.356178, alt_ft: 17775, gs_kts: 542, vs_fpm: 9664, hdg: 48 }),
  Object.freeze({ t: 1790745773, lat: 29.845093, lon: 38.360085, alt_ft: 18125, gs_kts: 531, vs_fpm: 10624, hdg: 44 }),
  Object.freeze({ t: 1790745775, lat: 29.850037, lon: 38.364468, alt_ft: 18575, gs_kts: 518, vs_fpm: 9152, hdg: 36 }),
  Object.freeze({ t: 1790745778, lat: 29.853836, lon: 38.367214, alt_ft: 18800, gs_kts: 512, vs_fpm: 5696, hdg: 31 }),
  Object.freeze({ t: 1790745780, lat: 29.859009, lon: 38.370331, alt_ft: 19100, gs_kts: 503, vs_fpm: 4864, hdg: 27 }),
  Object.freeze({ t: 1790745782, lat: 29.863819, lon: 38.372604, alt_ft: 19425, gs_kts: 481, vs_fpm: 6720, hdg: 20 }),
  Object.freeze({ t: 1790745784, lat: 29.868759, lon: 38.374294, alt_ft: 19825, gs_kts: 462, vs_fpm: 8384, hdg: 15 }),
  Object.freeze({ t: 1790745787, lat: 29.873428, lon: 38.375454, alt_ft: 20225, gs_kts: 446, vs_fpm: 9536, hdg: 12 }),
  Object.freeze({ t: 1790745790, lat: 29.87932, lon: 38.376804, alt_ft: 20700, gs_kts: 430, vs_fpm: 8192, hdg: 10 }),
  Object.freeze({ t: 1790745792, lat: 29.881277, lon: 38.377182, alt_ft: 20850, gs_kts: 423, vs_fpm: 6464, hdg: 10 }),
  Object.freeze({ t: 1790745794, lat: 29.88677, lon: 38.378368, alt_ft: 21175, gs_kts: 414, vs_fpm: 5248, hdg: 10 }),
  Object.freeze({ t: 1790745796, lat: 29.890457, lon: 38.379101, alt_ft: 21375, gs_kts: 404, vs_fpm: 4544, hdg: 10 }),
  Object.freeze({ t: 1790745798, lat: 29.894714, lon: 38.379944, alt_ft: 21550, gs_kts: 399, vs_fpm: 2944, hdg: 9 }),
  Object.freeze({ t: 1790745800, lat: 29.898651, lon: 38.380684, alt_ft: 21650, gs_kts: 394, vs_fpm: 2304, hdg: 9 }),
  Object.freeze({ t: 1790745803, lat: 29.902771, lon: 38.381424, alt_ft: 21725, gs_kts: 390, vs_fpm: 832, hdg: 8 }),
  Object.freeze({ t: 1790745805, lat: 29.907257, lon: 38.382164, alt_ft: 21725, gs_kts: 386, vs_fpm: -512, hdg: 7 }),
  Object.freeze({ t: 1790745807, lat: 29.910782, lon: 38.38269, alt_ft: 21675, gs_kts: 385, vs_fpm: -1600, hdg: 7 }),
  Object.freeze({ t: 1790745809, lat: 29.914328, lon: 38.383156, alt_ft: 21600, gs_kts: 384, vs_fpm: -3136, hdg: 6 }),
  Object.freeze({ t: 1790745812, lat: 29.918564, lon: 38.383644, alt_ft: 21425, gs_kts: 384, vs_fpm: -4224, hdg: 5 }),
  Object.freeze({ t: 1790745814, lat: 29.922335, lon: 38.38398, alt_ft: 21225, gs_kts: 385, vs_fpm: -5248, hdg: 3 }),
  Object.freeze({ t: 1790745816, lat: 29.927719, lon: 38.384293, alt_ft: 20875, gs_kts: 388, vs_fpm: -6720, hdg: 2 }),
  Object.freeze({ t: 1790745822, lat: 29.937561, lon: 38.384346, alt_ft: 20025, gs_kts: 397, vs_fpm: -9536, hdg: 358 }),
  Object.freeze({ t: 1790745824, lat: 29.941452, lon: 38.384129, alt_ft: 19650, gs_kts: 404, vs_fpm: -10496, hdg: 356 }),
  Object.freeze({ t: 1790745827, lat: 29.945984, lon: 38.383591, alt_ft: 19200, gs_kts: 411, vs_fpm: -10304, hdg: 353 }),
  Object.freeze({ t: 1790745829, lat: 29.95022, lon: 38.382881, alt_ft: 18800, gs_kts: 417, vs_fpm: -9984, hdg: 351 }),
  Object.freeze({ t: 1790745831, lat: 29.954269, lon: 38.382057, alt_ft: 18425, gs_kts: 428, vs_fpm: -10560, hdg: 348 }),
  Object.freeze({ t: 1790745833, lat: 29.959206, lon: 38.380791, alt_ft: 18025, gs_kts: 434, vs_fpm: -10240, hdg: 347 }),
  Object.freeze({ t: 1790745835, lat: 29.963533, lon: 38.379585, alt_ft: 17650, gs_kts: 440, vs_fpm: -9216, hdg: 346 }),
  Object.freeze({ t: 1790745838, lat: 29.968143, lon: 38.378212, alt_ft: 17275, gs_kts: 446, vs_fpm: -9472, hdg: 345 }),
  Object.freeze({ t: 1790745840, lat: 29.972193, lon: 38.376892, alt_ft: 16925, gs_kts: 452, vs_fpm: -9280, hdg: 344 }),
  Object.freeze({ t: 1790745842, lat: 29.976429, lon: 38.375408, alt_ft: 16600, gs_kts: 459, vs_fpm: -9600, hdg: 342 }),
  Object.freeze({ t: 1790745844, lat: 29.980759, lon: 38.373871, alt_ft: 16275, gs_kts: 464, vs_fpm: -8512, hdg: 342 }),
  Object.freeze({ t: 1790745846, lat: 29.984901, lon: 38.372334, alt_ft: 15975, gs_kts: 469, vs_fpm: -8512, hdg: 341 }),
  Object.freeze({ t: 1790745848, lat: 29.989231, lon: 38.370628, alt_ft: 15675, gs_kts: 473, vs_fpm: -7360, hdg: 341 }),
  Object.freeze({ t: 1790745851, lat: 29.996384, lon: 38.367867, alt_ft: 15275, gs_kts: 480, vs_fpm: -6144, hdg: 341 }),
  Object.freeze({ t: 1790745854, lat: 30.001474, lon: 38.365795, alt_ft: 15100, gs_kts: 482, vs_fpm: -3776, hdg: 340 }),
  Object.freeze({ t: 1790745856, lat: 30.006735, lon: 38.363655, alt_ft: 14975, gs_kts: 482, vs_fpm: -2368, hdg: 340 }),
  Object.freeze({ t: 1790745858, lat: 30.010712, lon: 38.361996, alt_ft: 14950, gs_kts: 479, vs_fpm: -1024, hdg: 340 }),
  Object.freeze({ t: 1790745890, lat: 30.070175, lon: 38.335606, alt_ft: 15375, gs_kts: 411, vs_fpm: -320, hdg: 338 }),
  Object.freeze({ t: 1790745922, lat: 30.125536, lon: 38.30938, alt_ft: 14925, gs_kts: 380, vs_fpm: -1344, hdg: 337 }),
  Object.freeze({ t: 1790745954, lat: 30.175415, lon: 38.28159, alt_ft: 14025, gs_kts: 364, vs_fpm: -448, hdg: 330 }),
  Object.freeze({ t: 1790745985, lat: 30.217291, lon: 38.252087, alt_ft: 14125, gs_kts: 325, vs_fpm: -128, hdg: 330 }),
  Object.freeze({ t: 1790746016, lat: 30.256487, lon: 38.22583, alt_ft: 13750, gs_kts: 311, vs_fpm: -320, hdg: 327 }),
  Object.freeze({ t: 1790746025, lat: 30.267427, lon: 38.21627, alt_ft: 13675, gs_kts: 311, vs_fpm: -448, hdg: 319 }),
  Object.freeze({ t: 1790746028, lat: 30.270126, lon: 38.213524, alt_ft: 13675, gs_kts: 311, vs_fpm: 320, hdg: 318 }),
  Object.freeze({ t: 1790746030, lat: 30.272141, lon: 38.211418, alt_ft: 13725, gs_kts: 310, vs_fpm: 256, hdg: 317 }),
  Object.freeze({ t: 1790746032, lat: 30.274796, lon: 38.208618, alt_ft: 13750, gs_kts: 308, vs_fpm: 1536, hdg: 317 }),
  Object.freeze({ t: 1790746035, lat: 30.276581, lon: 38.206787, alt_ft: 13775, gs_kts: 307, vs_fpm: 960, hdg: 317 }),
  Object.freeze({ t: 1790746037, lat: 30.278687, lon: 38.204578, alt_ft: 13825, gs_kts: 305, vs_fpm: 1152, hdg: 318 }),
  Object.freeze({ t: 1790746039, lat: 30.281342, lon: 38.201885, alt_ft: 13875, gs_kts: 304, vs_fpm: 960, hdg: 318 }),
  Object.freeze({ t: 1790746041, lat: 30.28372, lon: 38.199627, alt_ft: 13950, gs_kts: 301, vs_fpm: 1536, hdg: 319 }),
  Object.freeze({ t: 1790746043, lat: 30.286282, lon: 38.197155, alt_ft: 14025, gs_kts: 300, vs_fpm: 1344, hdg: 320 }),
  Object.freeze({ t: 1790746047, lat: 30.290098, lon: 38.193474, alt_ft: 14100, gs_kts: 297, vs_fpm: 1152, hdg: 320 }),
  Object.freeze({ t: 1790746078, lat: 30.322544, lon: 38.162548, alt_ft: 14075, gs_kts: 306, vs_fpm: -640, hdg: 323 }),
  Object.freeze({ t: 1790746087, lat: 30.332657, lon: 38.154762, alt_ft: 14000, gs_kts: 315, vs_fpm: -192, hdg: 328 }),
  Object.freeze({ t: 1790746091, lat: 30.339111, lon: 38.150349, alt_ft: 13975, gs_kts: 317, vs_fpm: -256, hdg: 329 }),
  Object.freeze({ t: 1790746093, lat: 30.34219, lon: 38.148376, alt_ft: 13975, gs_kts: 318, vs_fpm: 128, hdg: 330 }),
  Object.freeze({ t: 1790746096, lat: 30.344658, lon: 38.146782, alt_ft: 13975, gs_kts: 318, vs_fpm: 192, hdg: 330 }),
  Object.freeze({ t: 1790746318, lat: 30.622854, lon: 37.96809, alt_ft: 15175, gs_kts: 308, vs_fpm: 640, hdg: 326 }),
  Object.freeze({ t: 1790746402, lat: 30.725082, lon: 37.888496, alt_ft: 15225, gs_kts: 316, vs_fpm: 128, hdg: 319 }),
  Object.freeze({ t: 1790746600, lat: 30.93899, lon: 37.667999, alt_ft: 15025, gs_kts: 306, vs_fpm: 320, hdg: 318 }),
  Object.freeze({ t: 1790746691, lat: 31.031443, lon: 37.565498, alt_ft: 14800, gs_kts: 295, vs_fpm: 512, hdg: 306 }),
  Object.freeze({ t: 1790746796, lat: 31.101597, lon: 37.429375, alt_ft: 14825, gs_kts: 274, vs_fpm: 128, hdg: 296 }),
  Object.freeze({ t: 1790746927, lat: 31.177616, lon: 37.257549, alt_ft: 15175, gs_kts: 263, vs_fpm: -128, hdg: 270 }),
  Object.freeze({ t: 1790746944, lat: 31.172104, lon: 37.234711, alt_ft: 15000, gs_kts: 264, vs_fpm: -832, hdg: 240 }),
  Object.freeze({ t: 1790746962, lat: 31.156128, lon: 37.216995, alt_ft: 15000, gs_kts: 266, vs_fpm: 832, hdg: 212 }),
  Object.freeze({ t: 1790746980, lat: 31.136232, lon: 37.208275, alt_ft: 15150, gs_kts: 267, vs_fpm: 64, hdg: 191 }),
  Object.freeze({ t: 1790746997, lat: 31.113653, lon: 37.208824, alt_ft: 15150, gs_kts: 278, vs_fpm: -256, hdg: 166 }),
  Object.freeze({ t: 1790747015, lat: 31.09317, lon: 37.221954, alt_ft: 15000, gs_kts: 297, vs_fpm: -448, hdg: 138 }),
  Object.freeze({ t: 1790747033, lat: 31.079269, lon: 37.245861, alt_ft: 14950, gs_kts: 306, vs_fpm: 256, hdg: 114 }),
  Object.freeze({ t: 1790747050, lat: 31.070965, lon: 37.272713, alt_ft: 15100, gs_kts: 303, vs_fpm: 192, hdg: 101 }),
  Object.freeze({ t: 1790747068, lat: 31.068079, lon: 37.301441, alt_ft: 15300, gs_kts: 297, vs_fpm: 1088, hdg: 96 }),
  Object.freeze({ t: 1790747085, lat: 31.063889, lon: 37.328152, alt_ft: 15225, gs_kts: 294, vs_fpm: -320, hdg: 101 }),
  Object.freeze({ t: 1790747323, lat: 30.99472, lon: 37.712833, alt_ft: 15000, gs_kts: 305, vs_fpm: -128, hdg: 109 }),
  Object.freeze({ t: 1790747340, lat: 30.983494, lon: 37.737762, alt_ft: 14950, gs_kts: 298, vs_fpm: -128, hdg: 124 }),
  Object.freeze({ t: 1790747358, lat: 30.96855, lon: 37.758747, alt_ft: 15050, gs_kts: 290, vs_fpm: 896, hdg: 130 }),
  Object.freeze({ t: 1790747492, lat: 30.854078, lon: 37.917442, alt_ft: 15100, gs_kts: 288, vs_fpm: -64, hdg: 129 }),
  Object.freeze({ t: 1790747765, lat: 30.632172, lon: 38.248524, alt_ft: 14950, gs_kts: 278, vs_fpm: -256, hdg: 127 }),
  Object.freeze({ t: 1790747922, lat: 30.512741, lon: 38.438145, alt_ft: 14950, gs_kts: 270, vs_fpm: -64, hdg: 142 }),
  Object.freeze({ t: 1790747939, lat: 30.493904, lon: 38.447479, alt_ft: 14950, gs_kts: 263, vs_fpm: -320, hdg: 168 }),
  Object.freeze({ t: 1790747956, lat: 30.472303, lon: 38.449455, alt_ft: 15050, gs_kts: 267, vs_fpm: 64, hdg: 176 }),
  Object.freeze({ t: 1790748090, lat: 30.294434, lon: 38.459042, alt_ft: 14950, gs_kts: 316, vs_fpm: 192, hdg: 177 }),
  Object.freeze({ t: 1790748270, lat: 30.013113, lon: 38.465057, alt_ft: 15075, gs_kts: 334, vs_fpm: -768, hdg: 194 }),
  Object.freeze({ t: 1790748288, lat: 29.987228, lon: 38.454124, alt_ft: 15125, gs_kts: 331, vs_fpm: -128, hdg: 201 }),
  Object.freeze({ t: 1790748411, lat: 29.812088, lon: 38.373978, alt_ft: 14700, gs_kts: 328, vs_fpm: -256, hdg: 211 }),
  Object.freeze({ t: 1790748430, lat: 29.789474, lon: 38.352627, alt_ft: 14725, gs_kts: 325, vs_fpm: 192, hdg: 224 }),
  Object.freeze({ t: 1790748476, lat: 29.739525, lon: 38.298717, alt_ft: 14800, gs_kts: 322, vs_fpm: 256, hdg: 222 }),
  Object.freeze({ t: 1790748817, lat: 29.3638, lon: 37.897602, alt_ft: 15050, gs_kts: 331, vs_fpm: -64, hdg: 222 }),
  Object.freeze({ t: 1790751539, lat: 28.381176, lon: 36.598339, alt_ft: 0, gs_kts: 0, vs_fpm: 0, hdg: 73 }),
]);

/** Dive / recovery window used by #shorts=flydubai FPV hops. */
export const FZ1073_DIVE_WINDOW = Object.freeze({
  tStart: 1790745656,
  tEnd: 1790745865,
});

/** Overview camera over the Saudi desert dive corridor. */
export const FZ1073_OVERVIEW = Object.freeze({
  lon: 38.32,
  lat: 29.78,
  height: 120_000,
  heading: 20,
  pitch: -55,
  duration: 2.8,
});

/** Tabuk (TUU) divert context hop. */
export const FZ1073_TUU = Object.freeze({
  lon: 36.603,
  lat: 28.365,
  height: 45_000,
  heading: 200,
  pitch: -48,
  duration: 2.6,
});

/** @returns {Fz1073Point[]} */
export function fz1073DivePoints() {
  return FZ1073_TRACK.filter(
    (p) => p.t >= FZ1073_DIVE_WINDOW.tStart && p.t <= FZ1073_DIVE_WINDOW.tEnd,
  );
}

/**
 * Build Cesium-friendly FPV hop shots along the dive (nose-forward, altitude-aware).
 * Pitch steepens with descent rate; no custom HUD chrome.
 */
export function fz1073FpvShots() {
  const dive = fz1073DivePoints();
  if (!dive.length) return [];
  const peakVs = Math.min(...dive.map((p) => p.vs_fpm));
  const out = [];
  for (let i = 0; i < dive.length; i += 1) {
    const p = dive[i];
    const isKey =
      i === 0 ||
      i === dive.length - 1 ||
      p.vs_fpm <= -20_000 ||
      p.vs_fpm === peakVs ||
      i % 4 === 0;
    if (!isKey) continue;
    const sink = Math.min(0, p.vs_fpm);
    // Map 0 → -8°, -31000 → ~-28° nose-down without redesigning instruments.
    const pitch = -8 + (sink / 31_000) * 20;
    const heightM = Math.max(800, p.alt_ft * FZ1073_FT_TO_M);
    out.push(
      Object.freeze({
        lon: p.lon,
        lat: p.lat,
        height: heightM,
        heading: p.hdg,
        pitch,
        duration: p.vs_fpm <= -20_000 ? 1.6 : 1.1,
        alt_ft: p.alt_ft,
        vs_fpm: p.vs_fpm,
      }),
    );
  }
  return out;
}

