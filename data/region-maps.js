/**
 * data/region-maps.js
 * §100 The four regional maps the weather and the radar share. Coordinates
 * are kilometres, x east and y north, with the user's ballpark at (0, 0).
 * Outlines are coarse on purpose — engine/WeatherMap.js roughens them into
 * natural coastlines and shores, deterministically (the same every time).
 *
 * Everything here is fictional: no real places, borders or names.
 *
 * Feature kinds:
 *   water     — ocean, gulf or lake (polygon). `name` labels it.
 *   island    — land drawn over water (polygon).
 *   relief    — mountains or high ground, drawn as slightly lighter land (polygon).
 *   flat      — salt flat / dry lake, drawn pale (polygon).
 *   river     — polyline.
 *   border    — a state line (polyline), drawn dashed.
 * Parks: one per club (teamId → { x, y, city }). 'user' is ours; its city
 * comes from the save (state.userTeam.city).
 */

const lake = (cx, cy, r, sides = 9) =>
  Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    const k = 1 + 0.25 * Math.sin(a * 2 + cx);
    return [Math.round(cx + Math.cos(a) * r * k * 1.3), Math.round(cy + Math.sin(a) * r * k)];
  });

export const MAP_HALF_KM = 420;   // the drawn map runs ±420 km from our park

export const REGION_MAPS = Object.freeze({

  // ── North: a great lake along the top, a long lake to the northeast. ──
  north: {
    seed: 'map-north',
    parks: {
      user: { x: 0,    y: 0 },
      IRF:  { x: -210, y: 40,   city: 'Ironfield' },
      GRS:  { x: -120, y: -150, city: 'Greystone' },
      NHV:  { x: 55,   y: 178,  city: 'Northhaven' },
      RDC:  { x: 230,  y: -60,  city: 'Ridgecrest' },
      HLB:  { x: -60,  y: 110,  city: 'Hollowbrook' },
      CLW:  { x: -240, y: 160,  city: 'Coldwater' },
      FBG:  { x: 170,  y: 150,  city: 'Frostburg' },
      ASH:  { x: 110,  y: -200, city: 'Ashmont' },
      CLF:  { x: -285, y: -120, city: 'Clearfield' },
    },
    features: [
      { kind: 'water', name: 'Lake Northmere', rough: 0.2, pts: [[-480, 232], [-380, 208], [-300, 192], [-245, 188], [-200, 214], [-120, 232], [-40, 216], [30, 202], [70, 200], [110, 226], [170, 262], [210, 322], [190, 480], [-480, 480]] },
      { kind: 'water', name: 'Long Lake', rough: 0.22, pts: [[292, 42], [332, 30], [382, 62], [422, 142], [480, 262], [480, 480], [382, 480], [332, 330], [302, 200], [282, 110]] },
      { kind: 'water', rough: 0.3, pts: lake(-92, -42, 12) },
      { kind: 'water', rough: 0.3, pts: lake(140, 40, 9) },
      { kind: 'water', rough: 0.3, pts: lake(-182, -62, 10) },
      { kind: 'water', rough: 0.3, pts: lake(62, -128, 8) },
      { kind: 'water', rough: 0.3, pts: lake(-330, 40, 11) },
      { kind: 'river', pts: [[-480, -40], [-380, -20], [-300, -60], [-230, -40], [-150, -90], [-60, -70], [20, -110], [120, -100], [200, -140], [300, -120], [480, -170]] },
      { kind: 'river', pts: [[-20, 214], [-30, 140], [-10, 60], [-40, -10], [-30, -80]] },
      { kind: 'border', pts: [[-150, 212], [-150, 60], [-160, -20], [-160, -480]] },
      { kind: 'border', pts: [[-160, -20], [100, -20], [110, -60], [480, -60]] },
      { kind: 'border', pts: [[280, 480], [270, -60]] },
    ],
  },

  // ── South: the gulf along the bottom, a delta, a bay, a long river. ──
  south: {
    seed: 'map-south',
    parks: {
      user: { x: 0,    y: 0 },
      BSY:  { x: 170,  y: -98,  city: 'Bayside' },
      PLM:  { x: -150, y: 60,   city: 'Palmetto' },
      SRG:  { x: 90,   y: 140,  city: 'Sunridge' },
      CPF:  { x: -260, y: -30,  city: 'Copperfield' },
      BYO:  { x: -140, y: -172, city: 'Bayou' },
      CRV:  { x: 250,  y: 40,   city: 'Crestview' },
      SCT:  { x: 300,  y: -186, city: 'Suncoast' },
      DLT:  { x: -55,  y: -240, city: 'Delta' },
      MSG:  { x: 40,   y: -90,  city: 'Mossglen' },
    },
    features: [
      { kind: 'water', name: 'The Gulf', rough: 0.18, pts: [[-480, -205], [-330, -196], [-230, -200], [-170, -192], [-120, -205], [-92, -242], [-62, -282], [-28, -254], [10, -216], [60, -202], [110, -186], [140, -150], [156, -116], [186, -112], [200, -150], [230, -186], [300, -208], [360, -200], [480, -182], [480, -480], [-480, -480]] },
      { kind: 'island', rough: 0.25, pts: [[230, -232], [300, -246], [340, -240], [300, -238], [250, -228]] },
      { kind: 'island', rough: 0.25, pts: [[-300, -228], [-240, -232], [-210, -228], [-250, -224]] },
      { kind: 'water', rough: 0.3, pts: lake(-200, 150, 15) },
      { kind: 'water', rough: 0.3, pts: lake(180, 210, 10) },
      { kind: 'river', pts: [[-130, 480], [-120, 300], [-80, 200], [-95, 100], [-60, 0], [-70, -100], [-55, -200], [-62, -270]] },
      { kind: 'river', pts: [[480, 120], [360, 80], [300, 0], [220, -60], [172, -114]] },
      { kind: 'border', pts: [[-200, 480], [-200, 150], [-190, -196]] },
      { kind: 'border', pts: [[-200, 260], [480, 260]] },
      { kind: 'border', pts: [[210, 260], [205, -40], [190, -112]] },
    ],
  },

  // ── East: the ocean to the east, a deep bay reaching toward us, barrier islands. ──
  east: {
    seed: 'map-east',
    parks: {
      user: { x: 0,    y: 0 },
      HBR:  { x: 62,   y: 50,   city: 'Harborview' },
      TDL:  { x: 188,  y: -150, city: 'Tideland' },
      SVL:  { x: 205,  y: 232,  city: 'Seagrove' },
      LSH:  { x: 232,  y: -228, city: 'Lightshore' },
      MBY:  { x: -60,  y: -140, city: 'Millbay' },
      CLP:  { x: 138,  y: 172,  city: 'Cliffport' },
      CHP:  { x: -200, y: 80,   city: 'Cheswick' },
      RMD:  { x: -150, y: -60,  city: 'Reedmont' },
      GLP:  { x: 166,  y: -30,  city: 'Gulfport' },
    },
    features: [
      { kind: 'water', name: 'Atlantic Reach', rough: 0.18, pts: [[182, 480], [202, 380], [232, 300], [218, 240], [178, 200], [152, 172], [166, 120], [150, 96], [110, 76], [74, 54], [86, 38], [120, 32], [170, 40], [192, 10], [188, -60], [202, -130], [216, -180], [242, -232], [292, -272], [302, -332], [282, -480], [480, -480], [480, 480]] },
      { kind: 'island', rough: 0.2, pts: [[222, -80], [230, -82], [238, -200], [232, -202]] },
      { kind: 'island', rough: 0.2, pts: [[246, 300], [254, 298], [262, 200], [256, 198]] },
      { kind: 'water', rough: 0.3, pts: lake(-120, -200, 10) },
      { kind: 'water', rough: 0.3, pts: lake(-290, 200, 12) },
      { kind: 'river', pts: [[-480, 220], [-300, 200], [-150, 150], [-40, 90], [30, 62], [74, 50]] },
      { kind: 'river', pts: [[-480, -120], [-300, -100], [-160, -150], [-40, -200], [80, -200], [196, -150]] },
      { kind: 'border', pts: [[-480, 20], [-100, 20], [-90, -30], [190, -30]] },
      { kind: 'border', pts: [[-100, 20], [-110, 480]] },
      { kind: 'border', pts: [[-240, 20], [-250, -480]] },
    ],
  },

  // ── West: mountain ranges, a salt flat, a reservoir, a canyon river. ──
  west: {
    seed: 'map-west',
    parks: {
      user: { x: 0,    y: 0 },
      MSV:  { x: -160, y: -80,  city: 'Mesaview' },
      PKS:  { x: -232, y: 118,  city: 'Peakstone' },
      CYN:  { x: 180,  y: -180, city: 'Canyon' },
      DRT:  { x: 100,  y: -40,  city: 'Dryrock' },
      HGS:  { x: 240,  y: 60,   city: 'Highgrass' },
      ARD:  { x: -60,  y: -170, city: 'Arroyo' },
      RDW:  { x: -110, y: 170,  city: 'Ridgeway' },
      SDT:  { x: 60,   y: -262, city: 'Sundusted' },
      SLF:  { x: -210, y: -212, city: 'Saltflat' },
    },
    features: [
      { kind: 'relief', name: 'Sawtooth Range', rough: 0.22, pts: [[-330, 480], [-250, 380], [-200, 250], [-190, 120], [-230, -20], [-280, -150], [-330, -300], [-480, -300], [-480, 480]] },
      { kind: 'relief', name: 'High Mesa', rough: 0.25, pts: [[120, 480], [200, 330], [262, 262], [330, 290], [310, 480]] },
      { kind: 'relief', rough: 0.3, pts: [[300, -120], [380, -100], [420, -220], [340, -260]] },
      { kind: 'flat', name: 'Salt Flat', rough: 0.25, pts: [[-180, -232], [-90, -216], [-60, -262], [-110, -312], [-200, -300]] },
      { kind: 'water', name: 'Mirror Reservoir', rough: 0.25, pts: [[100, 100], [150, 126], [186, 150], [172, 166], [120, 136], [96, 116]] },
      { kind: 'river', pts: [[330, 480], [260, 200], [210, 40], [170, -100], [130, -250], [80, -480]] },
      { kind: 'river', pts: [[-190, 120], [-120, 60], [-40, 30], [80, 70], [100, 100]] },
      { kind: 'border', pts: [[-480, 240], [480, 240]] },
      { kind: 'border', pts: [[40, 240], [40, -480]] },
      { kind: 'border', pts: [[-480, -40], [40, -40]] },
    ],
  },
});

/**
 * Small towns are placed by engine/WeatherMap.js and named from these parts
 * (a word or root plus an ending, e.g. "Oakdale", "Pine Falls", "Wexford"). Generic, fictional combinations;
 * a name never repeats within a region or matches a club's city.
 */
export const TOWN_NAME_PARTS = Object.freeze({
  common: {
    // Real words: take either kind of ending ("Oakdale", "Oak Falls").
    words:  ['Oak', 'Elm', 'Ash', 'Pine', 'Cedar', 'Mill', 'Stone', 'Clay', 'Fair', 'Glen', 'Maple', 'Brook',
             'Willow', 'Hart', 'Fox', 'Bear', 'Deer', 'Spring', 'Rock', 'Green'],
    // Made-up roots: joined endings only ("Wexford", never "Wex Falls").
    roots:  ['Bran', 'Wex', 'Hollis', 'Marl', 'Kent', 'Lind', 'Dor', 'Fen', 'Garr', 'Hal', 'Lor', 'Mer',
             'Pell', 'Quill', 'Ros', 'Sal', 'Tam', 'Ver', 'Wen', 'Bel', 'Cor', 'Dun'],
    joined: ['ton', 'ville', 'field', 'ford', 'burg', 'dale', 'wood', 'ridge', 'mont', 'stead', 'ley', 'bury'],
    spaced: ['Falls', 'Crossing', 'Springs', 'Hill', 'Junction', 'Center'],
  },
  north: { words: ['Frost', 'Birch', 'Iron', 'Snow', 'Spruce', 'Elk', 'Granite'], joined: ['wick', 'holm', 'by'], spaced: ['Lake', 'Harbor'] },
  south: { words: ['Magnolia', 'Palm', 'Cypress', 'Pecan', 'Sugar', 'Cotton', 'Heron'], joined: ['port'], spaced: ['Bend', 'Bayou', 'Landing', 'Point'] },
  east:  { words: ['Tide', 'Bay', 'Salt', 'Harbor', 'Gull', 'Anchor', 'Dune', 'Cove'], joined: ['port', 'haven'], spaced: ['Neck', 'Inlet', 'Shores'] },
  west:  { words: ['Mesa', 'Sage', 'Red', 'Dust', 'Coyote', 'Juniper', 'Copper', 'Flint'], joined: [], spaced: ['Wells', 'Flats', 'Butte', 'Gulch'] },
});
