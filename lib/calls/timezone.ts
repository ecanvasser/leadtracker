/**
 * Resolving a prospect's timezone.
 *
 * "Thursday at 2" is in the prospect's time, not the broker's. Getting this
 * wrong does not produce a slightly-off reminder — it produces a missed call,
 * which is worse than no reminder at all.
 *
 * Resolution order, most trustworthy first:
 *   1. the property's state, from the loan file
 *   2. the phone's area code
 *   3. the broker's own zone
 *
 * Which one was used is recorded so the reminder can say how much to trust it.
 */

export type TimezoneSource = "property_state" | "area_code" | "broker_default";

export interface ResolvedTimezone {
  timeZone: string;
  source: TimezoneSource;
  /** Short human explanation, shown on the reminder. */
  detail: string;
}

/**
 * US state to IANA zone.
 *
 * States that genuinely straddle a boundary map to the zone holding the larger
 * share of population. That is a real source of error, and why the state is
 * only the first guess rather than the last word — the reminder shows both
 * times and the method so a wrong one is visible rather than silent.
 */
const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
  PR: "America/Puerto_Rico",
};

const STATE_NAMES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA",
  colorado: "CO", connecticut: "CT", delaware: "DE", florida: "FL",
  georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN",
  iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME",
  maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
  mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE",
  nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM",
  "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX",
  utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  "district of columbia": "DC", "puerto rico": "PR",
};

/**
 * NANP area code to IANA zone.
 *
 * Increasingly weak evidence — mobile numbers keep their area code across a
 * move — which is why it sits below the property address. Still far better
 * than assuming the broker's own zone.
 */
const AREA_CODE_TIMEZONES: Record<string, string> = {
  // Eastern
  201: "America/New_York", 202: "America/New_York", 203: "America/New_York",
  207: "America/New_York", 212: "America/New_York", 215: "America/New_York",
  216: "America/New_York", 220: "America/New_York", 223: "America/New_York",
  229: "America/New_York", 231: "America/Detroit", 234: "America/New_York",
  239: "America/New_York", 240: "America/New_York", 242: "America/New_York",
  248: "America/Detroit", 252: "America/New_York", 267: "America/New_York",
  272: "America/New_York", 276: "America/New_York", 278: "America/Detroit",
  289: "America/Toronto", 301: "America/New_York", 302: "America/New_York",
  304: "America/New_York", 305: "America/New_York", 313: "America/Detroit",
  315: "America/New_York", 321: "America/New_York", 326: "America/New_York",
  330: "America/New_York", 336: "America/New_York", 339: "America/New_York",
  343: "America/Toronto", 347: "America/New_York", 351: "America/New_York",
  352: "America/New_York", 380: "America/New_York", 386: "America/New_York",
  401: "America/New_York", 404: "America/New_York", 407: "America/New_York",
  410: "America/New_York", 412: "America/New_York", 413: "America/New_York",
  416: "America/Toronto", 419: "America/New_York", 434: "America/New_York",
  437: "America/Toronto", 440: "America/New_York", 443: "America/New_York",
  445: "America/New_York", 470: "America/New_York", 475: "America/New_York",
  478: "America/New_York", 484: "America/New_York", 502: "America/New_York",
  508: "America/New_York", 513: "America/New_York", 516: "America/New_York",
  517: "America/Detroit", 518: "America/New_York", 519: "America/Toronto",
  540: "America/New_York", 551: "America/New_York", 561: "America/New_York",
  567: "America/New_York", 570: "America/New_York", 571: "America/New_York",
  585: "America/New_York", 586: "America/Detroit", 588: "America/New_York",
  603: "America/New_York", 606: "America/New_York", 607: "America/New_York",
  609: "America/New_York", 610: "America/New_York", 613: "America/Toronto",
  614: "America/New_York", 616: "America/Detroit", 617: "America/New_York",
  631: "America/New_York", 646: "America/New_York", 647: "America/Toronto",
  678: "America/New_York", 680: "America/New_York", 681: "America/New_York",
  689: "America/New_York", 703: "America/New_York", 704: "America/New_York",
  705: "America/Toronto", 706: "America/New_York", 716: "America/New_York",
  717: "America/New_York", 718: "America/New_York", 724: "America/New_York",
  727: "America/New_York", 732: "America/New_York", 734: "America/Detroit",
  740: "America/New_York", 743: "America/New_York", 754: "America/New_York",
  757: "America/New_York", 762: "America/New_York", 770: "America/New_York",
  772: "America/New_York", 774: "America/New_York", 781: "America/New_York",
  786: "America/New_York", 787: "America/Puerto_Rico", 802: "America/New_York",
  803: "America/New_York", 804: "America/New_York", 810: "America/Detroit",
  813: "America/New_York", 814: "America/New_York", 828: "America/New_York",
  831: "America/Los_Angeles", 838: "America/New_York", 839: "America/New_York",
  843: "America/New_York", 845: "America/New_York", 848: "America/New_York",
  854: "America/New_York", 856: "America/New_York", 857: "America/New_York",
  859: "America/New_York", 860: "America/New_York", 862: "America/New_York",
  863: "America/New_York", 864: "America/New_York",
  878: "America/New_York", 904: "America/New_York", 906: "America/Detroit",
  908: "America/New_York", 910: "America/New_York", 912: "America/New_York",
  914: "America/New_York", 917: "America/New_York", 919: "America/New_York",
  929: "America/New_York", 937: "America/New_York", 939: "America/Puerto_Rico",
  941: "America/New_York", 947: "America/Detroit", 954: "America/New_York",
  959: "America/New_York", 973: "America/New_York", 980: "America/New_York",
  984: "America/New_York", 989: "America/Detroit",

  // Central
  205: "America/Chicago", 210: "America/Chicago", 214: "America/Chicago",
  217: "America/Chicago", 218: "America/Chicago", 224: "America/Chicago",
  225: "America/Chicago", 228: "America/Chicago", 230: "America/Chicago",
  251: "America/Chicago", 254: "America/Chicago", 256: "America/Chicago",
  262: "America/Chicago", 270: "America/Chicago", 281: "America/Chicago",
  308: "America/Chicago", 309: "America/Chicago", 312: "America/Chicago",
  314: "America/Chicago", 316: "America/Chicago", 317: "America/Indiana/Indianapolis",
  318: "America/Chicago", 319: "America/Chicago", 320: "America/Chicago",
  331: "America/Chicago", 334: "America/Chicago", 337: "America/Chicago",
  346: "America/Chicago", 361: "America/Chicago", 402: "America/Chicago",
  405: "America/Chicago", 409: "America/Chicago", 414: "America/Chicago",
  415: "America/Los_Angeles", 417: "America/Chicago", 430: "America/Chicago",
  432: "America/Chicago", 447: "America/Chicago", 458: "America/Los_Angeles",
  463: "America/Indiana/Indianapolis", 469: "America/Chicago",
  479: "America/Chicago", 501: "America/Chicago", 504: "America/Chicago",
  507: "America/Chicago", 512: "America/Chicago", 515: "America/Chicago",
  531: "America/Chicago", 534: "America/Chicago", 539: "America/Chicago",
  563: "America/Chicago", 573: "America/Chicago", 574: "America/Indiana/Indianapolis",
  580: "America/Chicago", 601: "America/Chicago", 605: "America/Chicago",
  608: "America/Chicago", 612: "America/Chicago", 615: "America/Chicago",
  618: "America/Chicago", 620: "America/Chicago", 630: "America/Chicago",
  636: "America/Chicago", 641: "America/Chicago", 651: "America/Chicago",
  660: "America/Chicago", 662: "America/Chicago", 682: "America/Chicago",
  708: "America/Chicago", 712: "America/Chicago", 713: "America/Chicago",
  715: "America/Chicago", 731: "America/Chicago", 737: "America/Chicago",
  763: "America/Chicago", 765: "America/Indiana/Indianapolis",
  769: "America/Chicago", 773: "America/Chicago", 779: "America/Chicago",
  785: "America/Chicago", 806: "America/Chicago", 815: "America/Chicago",
  816: "America/Chicago", 817: "America/Chicago", 830: "America/Chicago",
  832: "America/Chicago", 847: "America/Chicago", 850: "America/Chicago",
  870: "America/Chicago", 872: "America/Chicago", 901: "America/Chicago",
  903: "America/Chicago", 913: "America/Chicago", 915: "America/Denver",
  918: "America/Chicago", 920: "America/Chicago", 930: "America/Indiana/Indianapolis",
  931: "America/Chicago", 936: "America/Chicago", 940: "America/Chicago",
  945: "America/Chicago", 952: "America/Chicago", 956: "America/Chicago",
  972: "America/Chicago", 979: "America/Chicago", 985: "America/Chicago",

  // Mountain
  208: "America/Boise", 303: "America/Denver", 307: "America/Denver",
  385: "America/Denver", 406: "America/Denver", 435: "America/Denver",
  480: "America/Phoenix", 505: "America/Denver", 520: "America/Phoenix",
  575: "America/Denver", 602: "America/Phoenix", 623: "America/Phoenix",
  719: "America/Denver", 720: "America/Denver", 801: "America/Denver",
  928: "America/Phoenix", 970: "America/Denver", 986: "America/Boise",

  // Pacific and beyond
  206: "America/Los_Angeles", 209: "America/Los_Angeles", 213: "America/Los_Angeles",
  253: "America/Los_Angeles", 279: "America/Los_Angeles", 310: "America/Los_Angeles",
  323: "America/Los_Angeles", 341: "America/Los_Angeles", 350: "America/Los_Angeles",
  360: "America/Los_Angeles", 369: "America/Los_Angeles", 408: "America/Los_Angeles",
  424: "America/Los_Angeles", 425: "America/Los_Angeles", 442: "America/Los_Angeles",
  503: "America/Los_Angeles", 509: "America/Los_Angeles", 510: "America/Los_Angeles",
  530: "America/Los_Angeles", 559: "America/Los_Angeles", 562: "America/Los_Angeles",
  564: "America/Los_Angeles", 619: "America/Los_Angeles", 626: "America/Los_Angeles",
  628: "America/Los_Angeles", 650: "America/Los_Angeles", 657: "America/Los_Angeles",
  661: "America/Los_Angeles", 669: "America/Los_Angeles", 702: "America/Los_Angeles",
  707: "America/Los_Angeles", 714: "America/Los_Angeles", 725: "America/Los_Angeles",
  747: "America/Los_Angeles", 760: "America/Los_Angeles", 775: "America/Los_Angeles",
  805: "America/Los_Angeles", 808: "Pacific/Honolulu", 818: "America/Los_Angeles",
  820: "America/Los_Angeles", 858: "America/Los_Angeles", 900: "America/Los_Angeles",
  907: "America/Anchorage", 909: "America/Los_Angeles", 916: "America/Los_Angeles",
  925: "America/Los_Angeles", 949: "America/Los_Angeles", 951: "America/Los_Angeles",
  971: "America/Los_Angeles",
};

/** Pulls a two-letter state code out of a free-text US address. */
export function stateFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const text = address.trim();

  // "..., TX 75201" or "... TX" at the end — the usual shape.
  const abbrev = text.match(/,?\s*\b([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  if (abbrev && STATE_TIMEZONES[abbrev[1]]) return abbrev[1];

  // Spelled out anywhere in the string.
  const lower = text.toLowerCase();
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (new RegExp(`\\b${name}\\b`).test(lower)) return code;
  }

  return null;
}

/** Pulls the NANP area code out of a phone number in any common format. */
export function areaCodeFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");

  // 11 digits starting with the country code, or a plain 10.
  const national =
    digits.length === 11 && digits.startsWith("1")
      ? digits.slice(1)
      : digits.length === 10
        ? digits
        : null;

  if (!national) return null;

  const area = national.slice(0, 3);
  // Area codes never start with 0 or 1.
  if (area[0] === "0" || area[0] === "1") return null;
  return area;
}

/**
 * Resolves the zone a spoken time should be interpreted in.
 *
 * Always returns something — the broker's own zone is the floor — so a
 * reminder is never blocked on a missing address. The source is what tells
 * the broker whether to double-check.
 */
export function resolveProspectTimezone(input: {
  propertyAddress?: string | null;
  phone?: string | null;
  brokerTimezone: string;
}): ResolvedTimezone {
  const state = stateFromAddress(input.propertyAddress);
  if (state && STATE_TIMEZONES[state]) {
    return {
      timeZone: STATE_TIMEZONES[state],
      source: "property_state",
      detail: `property is in ${state}`,
    };
  }

  const area = areaCodeFromPhone(input.phone);
  if (area && AREA_CODE_TIMEZONES[area]) {
    return {
      timeZone: AREA_CODE_TIMEZONES[area],
      source: "area_code",
      detail: `area code ${area}`,
    };
  }

  return {
    timeZone: input.brokerTimezone,
    source: "broker_default",
    detail: "no location on file — assumed your timezone",
  };
}

/** Short zone label for display, e.g. "PT" / "CT". */
export function zoneAbbreviation(timeZone: string, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "short",
  }).formatToParts(instant);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}

/** "Thu 2:00 PM" in a given zone. */
export function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(instant);
}

/**
 * Renders a call time in both zones.
 *
 * Always both, and never a bare time — the whole class of bug this guards
 * against is a reminder that silently means a different hour than the broker
 * assumes. When the zones agree it says so rather than printing the same
 * thing twice.
 */
export function formatBothZones(
  instant: Date,
  prospectZone: string,
  brokerZone: string
): string {
  const theirs = `${formatInZone(instant, prospectZone)} ${zoneAbbreviation(prospectZone, instant)}`;

  if (sameWallClock(instant, prospectZone, brokerZone)) {
    return `${theirs} (same time for you both)`;
  }

  const yours = `${formatInZone(instant, brokerZone)} ${zoneAbbreviation(brokerZone, instant)}`;
  return `${theirs} (their time) — ${yours} (yours)`;
}

function sameWallClock(instant: Date, a: string, b: string): boolean {
  return formatInZone(instant, a) === formatInZone(instant, b);
}

/**
 * Builds the instant for a local wall-clock time in a given zone.
 *
 * Probes the zone rather than applying a stored offset, so a call six weeks
 * out lands at the right hour even across a DST transition.
 */
export function instantForLocalTime(
  date: string,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const guess = new Date(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`
  );

  /*
   * Correct the DATE as well as the time.
   *
   * Correcting only hour and minute lands on the right wall-clock time and
   * potentially the wrong day. Treating "6:00" as UTC puts the guess at 23:00
   * the previous evening in Los Angeles; nudging the clock forward six hours
   * then produces 6am — on the day before the one that was asked for. Every
   * local time earlier than the zone's offset was affected, so in California
   * that was midnight through 06:59, and a lead who wrote "call me at 6am
   * tomorrow" got a reminder a day early.
   *
   * Three passes rather than two, because correcting the day can itself cross
   * a DST transition and shift the hour again.
   */
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const targetDays = daysFromEpoch(date);

  let result = guess;
  for (let i = 0; i < 3; i++) {
    const parts = fmt.formatToParts(result);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";

    // Intl renders midnight as "24" in some zones under hour12:false.
    const h = Number(get("hour")) % 24;
    const m = Number(get("minute"));
    const landedOn = `${get("year")}-${get("month")}-${get("day")}`;

    const dayDriftMs = (targetDays - daysFromEpoch(landedOn)) * 86_400_000;
    const timeDriftMs = (hour - h) * 3_600_000 + (minute - m) * 60_000;

    if (dayDriftMs === 0 && timeDriftMs === 0) break;
    result = new Date(result.getTime() + dayDriftMs + timeDriftMs);
  }

  return result;
}

/** Whole days from the epoch for a YYYY-MM-DD string, zone-free. */
function daysFromEpoch(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}
