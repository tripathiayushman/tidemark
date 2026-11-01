import type { SignalDraft } from "@/lib/sources/types";
import type { RoleTag } from "@/lib/types";
import { formatMoney, isoDaysAgo } from "@/lib/pipeline/normalize";

// Deterministic generator for the demo dataset: fictional manufacturers whose
// dated records tell (or deliberately fail to tell) a buying story.
//   expansion   loan → permit → machines through customs (→ fleet)
//   new_line    supplier switch + machinery shipments
//   contract    big award → renovation permit → fleet growth
//   relocation  new-construction permit in a new city + new USDOT registration
//   lone        a single modest record (should NOT qualify)
//   stale       records older than 18 months (should NOT qualify)
//   off_icp     services company with signals (fails fit)

export interface SeedCompany {
  name: string;
  domain: string;
  naics_code: string;
  naics_title: string;
  industry: string;
  employee_count: number;
  annual_revenue: number;
  city: string;
  state: string;
  postal_code: string;
  street: string;
  description: string;
  story: string;
  records: { external_id: string; record_type: string; occurred_on: string; amount: number | null; signal: SignalDraft }[];
  contacts: { full_name: string; first_name: string; last_name: string; title: string; role_tag: RoleTag; seniority: string; department: string; email: string; phone: string }[];
}

// mulberry32
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SUBSECTORS = [
  { naics: "336211", title: "Motor vehicle body manufacturing", industry: "Truck bodies & trailers", nouns: ["Truck Bodies", "Trailer Works", "Body & Equipment", "Coachworks"] },
  { naics: "332710", title: "Machine shops", industry: "Precision machining", nouns: ["Precision", "Machine Works", "Machining", "Tool & Die"] },
  { naics: "332312", title: "Fabricated structural metal manufacturing", industry: "Metal fabrication", nouns: ["Fabrication", "Steel Works", "Metalcraft", "Structural"] },
  { naics: "326199", title: "Plastics product manufacturing", industry: "Plastics & molding", nouns: ["Plastics", "Molding", "Polymer Products", "Extrusions"] },
  { naics: "311999", title: "Food manufacturing", industry: "Food processing", nouns: ["Foods", "Provisions", "Kitchens", "Packing Co"] },
  { naics: "333249", title: "Industrial machinery manufacturing", industry: "Industrial machinery", nouns: ["Machinery", "Equipment Co", "Automation", "Systems"] },
  { naics: "336390", title: "Motor vehicle parts manufacturing", industry: "Auto parts", nouns: ["Components", "Auto Parts", "Drivetrain", "Stamping"] },
  { naics: "337110", title: "Wood kitchen cabinet manufacturing", industry: "Cabinets & millwork", nouns: ["Cabinetry", "Millwork", "Woodworks", "Casework"] },
  { naics: "325510", title: "Paint and coating manufacturing", industry: "Coatings", nouns: ["Coatings", "Finishes", "Chemical Co", "Paint Works"] },
  { naics: "334418", title: "Printed circuit assembly", industry: "Electronics manufacturing", nouns: ["Electronics", "Circuits", "Assemblies", "Controls"] },
];

const PREFIXES = [
  "Brightline", "Northgate", "Ridgefield", "Copperleaf", "Lakeshore", "Ironwood", "Bluestem", "Harborview", "Prairie Forge",
  "Cedar Bend", "Summit Ridge", "Kestrel", "Stonebridge", "Riverbend", "Redtail", "Granite Peak", "Westfork", "Oakhollow",
  "Silver Creek", "Tall Pine", "Fairhaven", "Maple Run", "Juniper", "Sandhill", "Ashgrove", "Bellwether", "Crosswind",
  "Driftwood", "Elmstead", "Foxglove", "Greystone", "Hollis", "Ivyridge", "Kingsford", "Larkspur", "Millbrook", "Northstar",
  "Overland", "Pinecrest", "Quarry Hill", "Rockport", "Sawtooth", "Thornbury", "Upland", "Valley Forge", "Windmere", "Yellowstone Ridge",
  "Bramble", "Clearwater Bend", "Deer Creek", "Eagle Rock", "Flint Hills", "Goldenrod", "Hawthorne", "Ironbridge", "Kettle River",
];

const PLACES = [
  ["Elkhart", "IN", "46514"], ["Fort Wayne", "IN", "46802"], ["Toledo", "OH", "43604"], ["Dayton", "OH", "45402"],
  ["Grand Rapids", "MI", "49503"], ["Kalamazoo", "MI", "49007"], ["Rockford", "IL", "61101"], ["Peoria", "IL", "61602"],
  ["Waukesha", "WI", "53186"], ["Green Bay", "WI", "54301"], ["Cedar Rapids", "IA", "52401"], ["Wichita", "KS", "67202"],
  ["Tulsa", "OK", "74103"], ["Greenville", "SC", "29601"], ["Spartanburg", "SC", "29306"], ["Chattanooga", "TN", "37402"],
  ["Huntsville", "AL", "35801"], ["Lexington", "KY", "40507"], ["San Antonio", "TX", "78205"], ["Fort Worth", "TX", "76102"],
];

const STREETS = ["Industrial Pkwy", "Commerce Dr", "Enterprise Blvd", "Factory Rd", "Foundry St", "Logistics Way", "Mill St", "Rail Spur Rd"];
const FIRST = ["Dana", "Marcus", "Priya", "Luis", "Kendra", "Owen", "Mei", "Tomas", "Grace", "Andre", "Hannah", "Victor", "Nadia", "Caleb", "Rosa", "Ethan", "Leah", "Samuel", "Imani", "Derek", "Alicia", "Jonah", "Farah", "Wes"];
const LAST = ["Park", "Ortiz", "Nguyen", "Whitaker", "Brennan", "Castillo", "Lindqvist", "Okafor", "Harlan", "Mendez", "Sato", "Kowalski", "Reyes", "Abbott", "Fischer", "Delgado", "Hughes", "Moreau", "Patel", "Strand"];

const MACHINES = [
  ["fiber laser cutting system", "Germany"], ["5-axis CNC machining center", "Japan"], ["800-ton press brake", "Italy"],
  ["robotic welding cell", "Japan"], ["injection molding press", "Austria"], ["powder coating line", "Germany"],
  ["high-speed packaging line", "Italy"], ["CNC router", "Germany"], ["SMT pick-and-place line", "Japan"], ["tube bending cell", "Italy"],
];

const ROLES: { title: string; role_tag: RoleTag; seniority: string; department: string }[] = [
  { title: "VP of Operations", role_tag: "decision_maker", seniority: "vp", department: "operations" },
  { title: "Plant Manager", role_tag: "runs_the_build", seniority: "manager", department: "operations" },
  { title: "Director of Manufacturing Engineering", role_tag: "runs_the_build", seniority: "director", department: "engineering" },
  { title: "Chief Financial Officer", role_tag: "influencer", seniority: "c_suite", department: "finance" },
  { title: "President", role_tag: "decision_maker", seniority: "owner", department: "executive" },
  { title: "Purchasing Manager", role_tag: "champion", seniority: "manager", department: "procurement" },
];

type Story = "expansion" | "new_line" | "contract" | "relocation" | "lone" | "stale" | "off_icp";
const STORY_MIX: Story[] = ["expansion", "expansion", "new_line", "new_line", "contract", "relocation", "lone", "lone", "stale", "off_icp"];

export function generateSeed(count = 120, seed = 20261101, today = new Date()): SeedCompany[] {
  const r = rng(seed);
  const pick = <T,>(arr: T[]) => arr[Math.floor(r() * arr.length)];
  const between = (a: number, b: number) => Math.round(a + r() * (b - a));
  const day = (n: number) => isoDaysAgo(n, today);
  const usedNames = new Set<string>();
  const out: SeedCompany[] = [];

  for (let i = 0; i < count; i++) {
    const story = STORY_MIX[i % STORY_MIX.length];
    const sub = story === "off_icp"
      ? { naics: "541611", title: "Management consulting services", industry: "Consulting", nouns: ["Advisors", "Consulting", "Partners", "Strategy Group"] }
      : SUBSECTORS[i % SUBSECTORS.length];
    let name = "";
    for (let tries = 0; tries < 20; tries++) {
      name = `${pick(PREFIXES)} ${pick(sub.nouns)}`;
      if (!usedNames.has(name)) break;
    }
    usedNames.add(name);
    const suffix = r() < 0.6 ? " Inc." : " LLC";
    const fullName = name + suffix;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const domain = `${slug}.example`;
    const [city, state, zip] = pick(PLACES);
    const employees = story === "off_icp" ? between(15, 60) : pick([between(40, 120), between(120, 400), between(400, 1200)]);
    const revenue = Math.round(employees * between(180, 320) * 1000);
    const street = `${between(100, 9800)} ${pick(STREETS)}`;
    const machine = pick(MACHINES);
    const records: SeedCompany["records"] = [];
    let n = 0;
    const add = (record_type: string, occurred_on: string, amount: number | null, signal: Omit<SignalDraft, "occurred_on">) =>
      records.push({ external_id: `${slug}:${n++}`, record_type, occurred_on, amount, signal: { ...signal, occurred_on } });

    const loanAmt = between(18, 64) * 100_000;
    const permitCost = between(12, 90) * 100_000;
    const sqft = between(18, 120) * 1000;
    const containers = between(4, 18);

    switch (story) {
      case "expansion": {
        const t0 = between(160, 260);
        add("sba_504_loan", day(t0), loanAmt, {
          category: "money_moving", signal_type: "sba_504_loan", title: `SBA 504 loan funded, ${formatMoney(loanAmt)}`,
          detail: `Financing for a new building at ${street}, ${city}`, amount: loanAmt, location: `${city}, ${state}`, strength: 70,
        });
        add("building_permit", day(t0 - between(30, 60)), permitCost, {
          category: "building", signal_type: "permit_new_construction", title: "Building permit approved",
          detail: `${formatMoney(permitCost)} · ${sqft.toLocaleString()} sq ft production addition · ${street}`, amount: permitCost, location: `${street}, ${city}, ${state}`, strength: 70,
        });
        if (r() < 0.7) add("building_permit_final", day(between(25, 70)), null, {
          category: "building", signal_type: "permit_closed", title: "Permit closed out on the new building",
          detail: `Final inspection passed · ${sqft.toLocaleString()} sq ft addition`, location: `${street}, ${city}, ${state}`, strength: 60,
        });
        add("customs_shipment", day(between(10, 45)), null, {
          category: "equipment_supply", signal_type: "customs_machinery", title: `Inbound shipment, ${containers} containers`,
          detail: `${cap(machine[0])} cleared customs from ${machine[1]}`, quantity: containers, unit: "containers", strength: 65,
        });
        if (r() < 0.5) add("fleet_growth", day(between(5, 30)), null, {
          category: "operations", signal_type: "fleet_growth", title: `Fleet grew from ${between(6, 12)} to ${between(14, 22)} trucks`,
          detail: "Power units added on the company's USDOT registration", strength: 50,
        });
        break;
      }
      case "new_line": {
        add("supplier_switch", day(between(70, 120)), null, {
          category: "equipment_supply", signal_type: "supplier_switch", title: "Switched primary steel supplier",
          detail: "Bills of lading show a new overseas mill replacing the previous domestic supplier", strength: 55,
        });
        add("customs_shipment", day(between(40, 65)), null, {
          category: "equipment_supply", signal_type: "customs_machinery", title: `Inbound shipment, ${containers} containers`,
          detail: `${cap(machine[0])} cleared customs from ${machine[1]}`, quantity: containers, unit: "containers", strength: 65,
        });
        const m2 = pick(MACHINES);
        add("customs_shipment", day(between(8, 35)), null, {
          category: "equipment_supply", signal_type: "customs_machinery", title: `Inbound shipment, ${between(2, 6)} containers`,
          detail: `${cap(m2[0])} cleared customs from ${m2[1]}`, strength: 60,
        });
        break;
      }
      case "contract": {
        const award = between(30, 240) * 100_000;
        add("contract_award", day(between(80, 140)), award, {
          category: "contracts", signal_type: "contract_award", title: `Won a ${formatMoney(award)} federal contract`,
          detail: `Defense Logistics Agency — production of fabricated assemblies over 3 years`, amount: award, strength: 70,
        });
        add("building_permit", day(between(30, 70)), permitCost, {
          category: "building", signal_type: "permit_renovation", title: "Building permit approved",
          detail: `${formatMoney(permitCost)} · interior renovation for added production capacity · ${street}`, amount: permitCost, location: `${street}, ${city}, ${state}`, strength: 55,
        });
        add("fleet_growth", day(between(5, 25)), null, {
          category: "operations", signal_type: "fleet_growth", title: `Fleet grew from ${between(4, 8)} to ${between(10, 16)} trucks`,
          detail: "Power units added on the company's USDOT registration", strength: 50,
        });
        break;
      }
      case "relocation": {
        const [nc, ns] = pick(PLACES.filter((p) => p[1] !== state));
        add("building_permit", day(between(100, 170)), permitCost * 2, {
          category: "building", signal_type: "permit_new_construction", title: "Building permit approved for new construction",
          detail: `${formatMoney(permitCost * 2)} · new ${(sqft * 2).toLocaleString()} sq ft plant in ${nc}, ${ns}`, amount: permitCost * 2, location: `${nc}, ${ns}`, strength: 70,
        });
        add("new_registration", day(between(15, 50)), null, {
          category: "operations", signal_type: "new_registration", title: `New USDOT registration in ${ns}`,
          detail: `Private fleet registered at the new ${nc} site`, location: `${nc}, ${ns}`, strength: 50,
        });
        break;
      }
      case "lone": {
        add("building_permit", day(between(20, 200)), between(2, 9) * 10_000, {
          category: "building", signal_type: "permit_renovation", title: "Building permit approved",
          detail: "Roof replacement on existing office area", amount: between(2, 9) * 10_000, location: `${city}, ${state}`, strength: 25,
        });
        break;
      }
      case "stale": {
        add("sba_504_loan", day(between(700, 900)), loanAmt, {
          category: "money_moving", signal_type: "sba_504_loan", title: `SBA 504 loan funded, ${formatMoney(loanAmt)}`,
          detail: `Financing for equipment`, amount: loanAmt, location: `${city}, ${state}`, strength: 60,
        });
        add("building_permit", day(between(620, 690)), permitCost, {
          category: "building", signal_type: "permit_new_construction", title: "Building permit approved",
          detail: `${formatMoney(permitCost)} · warehouse addition`, amount: permitCost, location: `${city}, ${state}`, strength: 60,
        });
        break;
      }
      case "off_icp": {
        add("contract_award", day(between(30, 90)), between(5, 20) * 100_000, {
          category: "contracts", signal_type: "contract_award", title: "Won a federal consulting contract",
          detail: "Program management support services", amount: between(5, 20) * 100_000, strength: 40,
        });
        break;
      }
    }

    // contacts: 2–4 per company
    const contacts: SeedCompany["contacts"] = [];
    const roleCount = between(2, 4);
    const roles = [...ROLES].sort(() => r() - 0.5).slice(0, roleCount);
    if (!roles.some((ro) => ro.role_tag === "decision_maker")) roles[0] = ROLES[0];
    for (const role of roles) {
      const first = pick(FIRST), last = pick(LAST);
      contacts.push({
        full_name: `${first} ${last}`, first_name: first, last_name: last, ...role,
        email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}`,
        phone: `+1 555 01${between(10, 99)}`,
      });
    }

    out.push({
      name: fullName, domain, naics_code: sub.naics, naics_title: sub.title, industry: sub.industry,
      employee_count: employees, annual_revenue: revenue, city, state, postal_code: zip, street,
      description: `${fullName} is a fictional ${sub.industry.toLowerCase()} company in ${city}, ${state} (demo data).`,
      story, records, contacts,
    });
  }
  return out;
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
