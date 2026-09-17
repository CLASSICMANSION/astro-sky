// ============================================================================
// astro.js — a compact, dependency-free celestial mechanics engine.
//
// Implements:
//   - Julian Date / Greenwich & Local Sidereal Time
//   - Low-precision Keplerian elements for Sun, Moon & the five naked-eye
//     planets (the classic "Paul Schlyter" formulation used widely in
//     amateur planetarium software; arc-minute-level accuracy — perfect
//     for a visual sky map, not for spacecraft navigation).
//   - RA/Dec -> Alt/Az transformation for a given observer & instant.
//   - A curated bright-star catalog (J2000 RA/Dec) with constellation
//     line figures.
// ============================================================================

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const deg2rad = d => d * DEG;
export const rad2deg = r => r * RAD;
export const norm360 = d => { d = d % 360; return d < 0 ? d + 360 : d; };
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// Days since 1999-12-31 00:00 UT (the epoch used by the Schlyter elements).
export function daysSinceEpoch(date) {
  const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0); // JD 2451545.0
  const ms = date.getTime() - J2000;
  return ms / 86400000 - 1.5 + 1.5; // days since 2000-01-01 12:00 UT
}

export function julianDate(date) {
  return 2451545.0 + daysSinceEpoch(date);
}

// Greenwich Mean Sidereal Time, in degrees.
export function gmstDeg(date) {
  const jd = julianDate(date);
  const T = (jd - 2451545.0) / 36525.0;
  let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545.0)
             + 0.000387933 * T * T - (T * T * T) / 38710000.0;
  return norm360(gmst);
}

// Local Sidereal Time in degrees, lon in degrees East-positive.
export function lstDeg(date, lonDeg) {
  return norm360(gmstDeg(date) + lonDeg);
}

// ---------------------------------------------------------------------------
// RA/Dec (degrees) -> Alt/Az (degrees), given observer lat & LST (all deg)
// ---------------------------------------------------------------------------
export function raDecToAltAz(raDeg, decDeg, latDeg, lstDegVal) {
  const ha = deg2rad(norm360(lstDegVal - raDeg));
  const dec = deg2rad(decDeg);
  const lat = deg2rad(latDeg);

  const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(ha);
  const alt = Math.asin(clamp(sinAlt, -1, 1));

  let cosAz = (Math.sin(dec) - Math.sin(alt) * Math.sin(lat)) / (Math.cos(alt) * Math.cos(lat));
  cosAz = clamp(cosAz, -1, 1);
  let az = Math.acos(cosAz);
  if (Math.sin(ha) > 0) az = 2 * Math.PI - az;

  return { alt: rad2deg(alt), az: rad2deg(az) };
}

// Ecliptic (lon/lat, deg) -> Equatorial (RA/Dec, deg) for a given obliquity (deg)
export function eclipticToEquatorial(lonDeg, latDeg, oblDeg) {
  const lon = deg2rad(lonDeg), lat = deg2rad(latDeg), obl = deg2rad(oblDeg);
  const x = Math.cos(lon) * Math.cos(lat);
  const y = Math.cos(obl) * Math.sin(lon) * Math.cos(lat) - Math.sin(obl) * Math.sin(lat);
  const z = Math.sin(obl) * Math.sin(lon) * Math.cos(lat) + Math.cos(obl) * Math.sin(lat);
  const ra = norm360(rad2deg(Math.atan2(y, x)));
  const dec = rad2deg(Math.asin(clamp(z, -1, 1)));
  return { ra, dec };
}

// Galactic latitude (deg) of an equatorial J2000 RA/Dec — used only to bias
// the density of the procedural background starfield toward the real Milky
// Way plane, not to claim per-star astrometric accuracy for filler stars.
const NGP_RA = 192.85948, NGP_DEC = 27.12825;
export function galacticLatitude(raDeg, decDeg) {
  const ra = deg2rad(raDeg), dec = deg2rad(decDeg);
  const raN = deg2rad(NGP_RA), decN = deg2rad(NGP_DEC);
  const sinB = Math.sin(dec) * Math.sin(decN) + Math.cos(dec) * Math.cos(decN) * Math.cos(ra - raN);
  return rad2deg(Math.asin(clamp(sinB, -1, 1)));
}

// ---------------------------------------------------------------------------
// Keplerian orbital elements (Schlyter low-precision set), d = days since epoch
// ---------------------------------------------------------------------------
function solveKepler(M, e) {
  let E = M + e * Math.sin(M) * (1.0 + e * Math.cos(M));
  for (let i = 0; i < 8; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-7) break;
  }
  return E;
}

// Returns heliocentric ecliptic rectangular coords (AU) + true anomaly/dist
function planetHeliocentric(d, N, i, w, a, e, M) {
  N = deg2rad(norm360(N)); i = deg2rad(i); w = deg2rad(norm360(w)); M = deg2rad(norm360(M));
  const E = solveKepler(M, e);
  const xv = a * (Math.cos(E) - e);
  const yv = a * (Math.sqrt(1 - e * e) * Math.sin(E));
  const v = Math.atan2(yv, xv);
  const r = Math.sqrt(xv * xv + yv * yv);

  const xh = r * (Math.cos(N) * Math.cos(v + w) - Math.sin(N) * Math.sin(v + w) * Math.cos(i));
  const yh = r * (Math.sin(N) * Math.cos(v + w) + Math.cos(N) * Math.sin(v + w) * Math.cos(i));
  const zh = r * (Math.sin(v + w) * Math.sin(i));
  return { xh, yh, zh, r };
}

function elementsFor(planet, d) {
  switch (planet) {
    case 'mercury': return {
      N: 48.3313 + 3.24587e-5 * d, i: 7.0047 + 5.00e-8 * d, w: 29.1241 + 1.01444e-5 * d,
      a: 0.387098, e: 0.205635 + 5.59e-10 * d, M: 168.6562 + 4.0923344368 * d };
    case 'venus': return {
      N: 76.6799 + 2.46590e-5 * d, i: 3.3946 + 2.75e-8 * d, w: 54.8910 + 1.38374e-5 * d,
      a: 0.723330, e: 0.006773 - 1.302e-9 * d, M: 48.0052 + 1.6021302244 * d };
    case 'mars': return {
      N: 49.5574 + 2.11081e-5 * d, i: 1.8497 - 1.78e-8 * d, w: 286.5016 + 2.92961e-5 * d,
      a: 1.523688, e: 0.093405 + 2.516e-9 * d, M: 18.6021 + 0.5240207766 * d };
    case 'jupiter': return {
      N: 100.4542 + 2.76854e-5 * d, i: 1.3030 - 1.557e-7 * d, w: 273.8777 + 1.64505e-5 * d,
      a: 5.20256, e: 0.048498 + 4.469e-9 * d, M: 19.8950 + 0.0830853001 * d };
    case 'saturn': return {
      N: 113.6634 + 2.38980e-5 * d, i: 2.4886 - 1.081e-7 * d, w: 339.3939 + 2.97661e-5 * d,
      a: 9.55475, e: 0.055546 - 9.499e-9 * d, M: 316.9670 + 0.0334442282 * d };
    case 'uranus': return {
      N: 74.0005 + 1.3978e-5 * d, i: 0.7733 + 1.9e-8 * d, w: 96.6612 + 3.0565e-5 * d,
      a: 19.18171 - 1.55e-8 * d, e: 0.047318 + 7.45e-9 * d, M: 142.5905 + 0.011725806 * d };
    case 'neptune': return {
      N: 131.7806 + 3.0173e-5 * d, i: 1.7700 - 2.55e-7 * d, w: 272.8461 - 6.027e-6 * d,
      a: 30.05826 + 3.313e-8 * d, e: 0.008606 + 2.15e-9 * d, M: 260.2471 + 0.005995147 * d };
  }
}

function sunElements(d) {
  return {
    w: 282.9404 + 4.70935e-5 * d,
    a: 1.000000,
    e: 0.016709 - 1.151e-9 * d,
    M: 356.0470 + 0.9856002585 * d
  };
}

function obliquity(d) { return 23.4393 - 3.563e-7 * d; }

// Sun geocentric RA/Dec + apparent ecliptic longitude (deg) + distance (AU)
export function sunPosition(date) {
  const d = daysSinceEpoch(date);
  const s = sunElements(d);
  const M = deg2rad(norm360(s.M));
  const E = solveKepler(M, s.e);
  const xv = s.a * (Math.cos(E) - s.e);
  const yv = s.a * (Math.sqrt(1 - s.e * s.e) * Math.sin(E));
  const r = Math.sqrt(xv * xv + yv * yv);
  const trueAnom = Math.atan2(yv, xv);
  const lon = norm360(rad2deg(trueAnom) + s.w);
  const eq = eclipticToEquatorial(lon, 0, obliquity(d));
  return { ra: eq.ra, dec: eq.dec, dist: r, eclipticLon: lon };
}

// Moon geocentric RA/Dec + distance (Earth radii) + elongation from Sun (deg, for phase)
export function moonPosition(date, sunEclLon) {
  const d = daysSinceEpoch(date);
  const N = 125.1228 - 0.0529538083 * d;
  const i = 5.1454;
  const w = 318.0634 + 0.1643573223 * d;
  const a = 60.2666;
  const e = 0.054900;
  const M = 115.3654 + 13.0649929509 * d;

  const h = planetHeliocentric(d, N, i, w, a, e, M); // reuse geometry (geocentric here, "helio" name is generic)
  let lon = norm360(rad2deg(Math.atan2(h.yh, h.xh)));
  let lat = rad2deg(Math.asin(clamp(h.zh / h.r, -1, 1)));
  const dist = h.r;

  // A few of the largest perturbations (Sun) for a nicer approximation.
  const Ms = deg2rad(norm360(sunElements(d).M));
  const Mm = deg2rad(norm360(M));
  const Dm = deg2rad(norm360(lon - (norm360(sunElements(d).M + sunElements(d).w))));
  lon += -1.274 * Math.sin(Mm - 2 * Dm)
         + 0.658 * Math.sin(2 * Dm)
         - 0.186 * Math.sin(Ms)
         - 0.059 * Math.sin(2 * Mm - 2 * Dm)
         - 0.057 * Math.sin(Mm - 2 * Dm + Ms)
         + 0.053 * Math.sin(Mm + 2 * Dm)
         + 0.046 * Math.sin(2 * Dm - Ms)
         + 0.041 * Math.sin(Mm - Ms);
  const eq = eclipticToEquatorial(norm360(lon), lat, obliquity(d));
  const elongation = norm360(lon - sunEclLon);
  return { ra: eq.ra, dec: eq.dec, dist, elongation };
}

// Planet geocentric RA/Dec + distance to Earth (AU) + phase angle (for magnitude flavor)
export function planetPosition(name, date) {
  const d = daysSinceEpoch(date);
  const el = elementsFor(name, d);
  const p = planetHeliocentric(d, el.N, el.i, el.w, el.a, el.e, el.M);

  const s = sunElements(d);
  const Ms = deg2rad(norm360(s.M));
  const Es = solveKepler(Ms, s.e);
  const xs = s.a * (Math.cos(Es) - s.e);
  const ys = s.a * (Math.sqrt(1 - s.e * s.e) * Math.sin(Es));
  // Earth is opposite the Sun as seen geocentrically:
  const xEarth = -xs, yEarth = -ys;

  const xg = p.xh + xEarth;
  const yg = p.yh + yEarth;
  const zg = p.zh;
  const dist = Math.sqrt(xg * xg + yg * yg + zg * zg);

  const lon = norm360(rad2deg(Math.atan2(yg, xg)));
  const lat = rad2deg(Math.asin(clamp(zg / dist, -1, 1)));
  const eq = eclipticToEquatorial(lon, lat, obliquity(d));
  return { ra: eq.ra, dec: eq.dec, dist };
}

// ---------------------------------------------------------------------------
// Bright star catalog — [name, RA(hours, J2000), Dec(deg, J2000), mag]
// Curated for sky-recognisability: all-sky bright stars + classic asterisms.
// ---------------------------------------------------------------------------
export const STARS = [
  ["Polaris",2.530,89.264,1.98,433],["Dubhe",11.062,61.751,1.79,123],["Merak",11.031,56.382,2.37,79.7],
["Phecda",11.897,53.695,2.44,83.2],["Megrez",12.257,57.033,3.31,58.4],["Alioth",12.900,55.960,1.77,82.6],
["Mizar",13.399,54.925,2.23,83],["Alkaid",13.792,49.313,1.85,101],["Kochab",14.845,74.156,2.07,130],
["Pherkad",15.345,71.834,3.05,487],["Betelgeuse",5.919,7.407,0.42,548],["Rigel",5.242,-8.202,0.18,860],
["Bellatrix",5.418,6.350,1.64,250],["Mintaka",5.533,-0.299,2.23,1200],["Alnilam",5.604,-1.202,1.69,2000],
["Alnitak",5.679,-1.943,1.74,800],["Saiph",5.796,-9.670,2.07,650],["Meissa",5.586,9.934,3.39,1100],
["Sirius",6.752,-16.716,-1.46,8.6],["Adhara",6.977,-28.972,1.50,430],["Wezen",7.140,-26.393,1.83,1800],
["Mirzam",6.378,-17.956,1.98,500],["Aludra",7.401,-29.303,2.45,2000],["Procyon",7.655,5.225,0.34,11.5],
["Gomeisa",7.453,8.290,2.89,170],["Castor",7.577,31.888,1.58,51],["Pollux",7.755,28.026,1.14,34],
["Alhena",6.629,16.399,1.93,109],["Mebsuta",6.732,25.131,2.98,840],["Tejat",6.383,22.514,2.87,230],
["Capella",5.278,45.998,0.08,43],["Menkalinan",5.992,44.947,1.90,82],["Aldebaran",4.599,16.509,0.85,65],
["Elnath",5.438,28.608,1.65,130],["Vega",18.616,38.784,0.03,25],["Sheliak",18.835,33.363,3.52,960],
["Sulafat",18.982,32.690,3.24,620],["Deneb",20.690,45.280,1.25,2600],["Sadr",20.371,40.257,2.23,1800],
["Gienah Cygni",20.770,33.970,2.46,72],["Fawaris",19.749,45.131,2.87,165],["Albireo",19.512,27.960,3.08,430],
["Altair",19.846,8.868,0.76,16.7],["Tarazed",19.771,10.613,2.72,395],["Alshain",19.921,6.407,3.71,45],
["Regulus",10.139,11.967,1.35,79],["Denebola",11.818,14.572,2.14,36],["Algieba",10.333,19.842,2.08,130],
["Zosma",11.235,20.524,2.56,58],["Chertan",11.237,15.430,3.34,165],["Spica",13.420,-11.161,0.98,250],
["Vindemiatrix",13.036,10.959,2.83,110],["Porrima",12.694,-1.450,2.74,38],["Arcturus",14.261,19.182,-0.05,37],
["Izar",14.749,27.074,2.35,210],["Seginus",14.535,38.308,3.03,85],["Nekkar",15.032,40.391,3.49,131],
["Antares",16.490,-26.432,0.96,550],["Shaula",17.560,-37.104,1.62,570],["Sargas",17.622,-42.998,1.86,272],
["Dschubba",16.006,-22.622,2.29,400],["Graffias",16.090,-19.805,2.56,530],["Lesath",17.513,-37.296,2.69,520],
["Kaus Australis",18.403,-34.385,1.79,143],["Nunki",18.921,-26.297,2.05,228],["Ascella",19.043,-29.880,2.60,88],
["Kaus Media",18.350,-29.828,2.72,305],["Kaus Borealis",18.467,-25.422,2.82,78],["Schedar",0.675,56.537,2.24,228],
["Caph",0.153,59.150,2.28,55],["Tsih",0.945,60.717,2.47,610],["Ruchbah",1.430,60.235,2.68,99],
["Segin",1.906,63.670,3.35,440],["Mirfak",3.405,49.861,1.79,590],["Algol",3.136,40.956,2.09,90],
["Markab",23.079,15.205,2.49,133],["Scheat",23.063,28.083,2.42,196],["Algenib",0.221,15.184,2.83,390],
["Alpheratz",0.140,29.091,2.06,97],["Mirach",1.162,35.621,2.05,197],["Almach",2.065,42.330,2.10,350],
["Acrux",12.443,-63.099,0.77,320],["Mimosa",12.795,-59.689,1.25,280],["Gacrux",12.519,-57.113,1.63,88],
["Imai",12.252,-58.749,3.39,360],["Rigil Kentaurus",14.660,-60.834,-0.27,4.37],["Hadar",14.064,-60.373,0.61,390],
["Fomalhaut",22.961,-29.622,1.16,25],["Canopus",6.399,-52.696,-0.74,310],["Achernar",1.629,-57.237,0.45,139],
["Peacock",20.427,-56.735,1.94,180],["Alnair",22.137,-46.961,1.74,101],["Alphard",9.460,-8.659,1.98,177],
["Alphecca",15.578,26.715,2.23,75],["Rasalhague",17.582,12.560,2.08,47],["Enif",21.736,9.875,2.40,690],
["Diphda",0.727,-17.987,2.04,96],["Hamal",2.119,23.462,2.00,66],["Mira",2.322,-2.977,3.04,300],
["Sheratan",1.911,20.808,2.64,60],["Menkar",3.038,4.090,2.54,220],["Alcyone",3.791,24.105,2.85,440],
["Electra",3.748,24.113,3.72,444],["Maia",3.764,24.367,3.87,444],["Merope",3.772,23.948,4.14,444],
["Taygeta",3.753,24.467,4.30,444],["Atlas",3.819,24.053,3.62,444],["Pleione",3.820,24.135,5.05,444],
["Sadalmelik",22.096,-0.320,2.94,520],["Sadalsuud",21.526,-5.571,2.87,540],["Yed Prior",16.239,-3.694,2.75,170],
["Unukalhai",15.738,6.426,2.63,74]
];

// Constellation figures: [constellation, [starName, starName], ...]
export const CONSTELLATION_LINES = [
  ["Ursa Major", [["Dubhe","Merak"],["Merak","Phecda"],["Phecda","Megrez"],["Megrez","Dubhe"],
    ["Megrez","Alioth"],["Alioth","Mizar"],["Mizar","Alkaid"]]],
  ["Ursa Minor", [["Polaris","Kochab"],["Kochab","Pherkad"]]],
  ["Orion", [["Betelgeuse","Bellatrix"],["Bellatrix","Mintaka"],["Mintaka","Alnilam"],
    ["Alnilam","Alnitak"],["Alnitak","Saiph"],["Saiph","Rigel"],["Rigel","Mintaka"],
    ["Betelgeuse","Alnitak"],["Bellatrix","Meissa"],["Meissa","Betelgeuse"]]],
  ["Canis Major", [["Sirius","Mirzam"],["Sirius","Adhara"],["Adhara","Wezen"],["Wezen","Aludra"]]],
  ["Canis Minor", [["Procyon","Gomeisa"]]],
  ["Gemini", [["Castor","Pollux"],["Pollux","Alhena"],["Castor","Tejat"],["Tejat","Mebsuta"],
    ["Mebsuta","Alhena"]]],
  ["Auriga", [["Capella","Menkalinan"],["Menkalinan","Elnath"]]],
  ["Taurus", [["Aldebaran","Elnath"]]],
  ["Lyra", [["Vega","Sheliak"],["Sheliak","Sulafat"],["Sulafat","Vega"]]],
  ["Cygnus", [["Deneb","Sadr"],["Sadr","Gienah Cygni"],["Sadr","Fawaris"],["Sadr","Albireo"]]],
  ["Aquila", [["Altair","Tarazed"],["Altair","Alshain"]]],
  ["Leo", [["Regulus","Algieba"],["Algieba","Zosma"],["Zosma","Denebola"],["Zosma","Chertan"],
    ["Chertan","Regulus"]]],
  ["Virgo", [["Spica","Porrima"],["Porrima","Vindemiatrix"]]],
  ["Bootes", [["Arcturus","Izar"],["Arcturus","Seginus"],["Seginus","Nekkar"]]],
  ["Scorpius", [["Antares","Dschubba"],["Dschubba","Graffias"],["Antares","Sargas"],
    ["Sargas","Shaula"],["Shaula","Lesath"]]],
  ["Sagittarius", [["Kaus Media","Kaus Australis"],["Kaus Australis","Ascella"],
    ["Kaus Media","Kaus Borealis"],["Kaus Media","Nunki"]]],
  ["Cassiopeia", [["Caph","Schedar"],["Schedar","Tsih"],["Tsih","Ruchbah"],["Ruchbah","Segin"]]],
  ["Perseus", [["Mirfak","Algol"]]],
  ["Pegasus", [["Markab","Scheat"],["Scheat","Alpheratz"],["Alpheratz","Algenib"],["Algenib","Markab"]]],
  ["Andromeda", [["Alpheratz","Mirach"],["Mirach","Almach"]]],
  ["Crux", [["Acrux","Gacrux"],["Mimosa","Imai"]]],
  ["Centaurus", [["Rigil Kentaurus","Hadar"]]]
];

// Star clusters worth labeling on the sky (not full constellations) —
// [label, [member star names to average for the label's position]]
export const CLUSTERS = [
  ["Pleiades", ["Alcyone","Electra","Maia","Merope","Taygeta","Atlas","Pleione"]]
];
