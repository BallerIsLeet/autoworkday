export type Entry = {
  date: string;
  kind: "work" | "in" | "out" | "deduct" | "payday" | "other";
  type: string;
  start: number | null;
  end: number | null;
  reason: string | null;
  hours: number | null;
  paid: boolean;
  status: string;
  note: string;
};

export type Week = {
  title: string;
  start: string;
  days: { date: string; label: string; total: number }[];
  entries: Entry[];
};

function clockMin(s: string, nth = 0): number | null {
  const all = [...s.matchAll(/(\d{1,2}):(\d{2})\s*([ap])\.?m\.?/gi)];
  const m = all[nth];
  if (!m) return null;
  return ((Number(m[1]) % 12) + (m[3].toLowerCase() === "p" ? 12 : 0)) * 60 + Number(m[2]);
}

function momentMin(v: any): number | null {
  if (v && v.H != null && v.m != null) return Number(v.H) * 60 + Number(v.m);
  return null;
}

function collect(obj: any, out: any[], depth = 0) {
  if (depth > 40 || obj == null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const x of obj) collect(x, out, depth + 1);
    return;
  }
  if (obj.widget === "calendarEntry") {
    out.push(obj);
    return;
  }
  for (const v of Object.values(obj)) collect(v, out, depth + 1);
}

function toEntry(e: any): Entry | null {
  const title: string = e.title?.value ?? "";
  const sub: string = e.subtitle1?.value ?? "";
  const status: string = e.style?.value ?? "";
  const date: string = e.date?.text ?? "";
  const quantity = typeof e.quantity?.value === "number" ? e.quantity.value : null;
  const base: Entry = {
    date, kind: "other", type: title, start: null, end: null, reason: null,
    hours: quantity, paid: false, status, note: "",
  };
  if (!date || !title) return null;

  if (title === "Worked Time") {
    const start = momentMin(e.startMoment?.value) ?? clockMin(sub, 0);
    let end = momentMin(e.endMoment?.value) ?? clockMin(sub, 1);
    if (start != null && end != null && end < start) end += 1440;
    const reason = /\(([^)]+)\)\s*$/.exec(sub)?.[1] ?? null;
    return { ...base, kind: "work", start, end, reason };
  }
  if (title === "Unmatched Check-in") return { ...base, kind: "in", start: clockMin(sub) };
  if (title === "Unmatched Check-out") return { ...base, kind: "out", end: clockMin(sub) };
  if (/^Unpaid (Meal|Break)/i.test(title)) {
    const hours = quantity ?? parseFloat(sub);
    return { ...base, kind: "deduct", hours: Number.isFinite(hours) ? hours : null, paid: /paid/i.test(sub.replace(/^[-\d.\s]+/, "")) };
  }
  if (title === "Pay date") return { ...base, kind: "payday", note: sub };
  if (status === "Non-Event") return null;
  return { ...base, note: sub };
}

export function parseWeek(data: any): Week {
  const cal = data?.body?.children?.[0] ?? {};
  const titles = Object.entries(cal.weekTitles ?? {});
  const days = (cal.dayInfo ?? []).map((d: any) => ({
    date: d.date?.text ?? "",
    label: d.formattedDateShort?.value ?? "",
    total: Number(d.totalForDay?.value ?? 0) || 0,
  }));
  const raw: any[] = [];
  collect(data, raw);
  const entries = raw.map(toEntry).filter((x): x is Entry => x !== null);
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.start ?? a.end ?? -1) - (b.start ?? b.end ?? -1));
  return {
    title: String(titles[0]?.[1] ?? ""),
    start: String(titles[0]?.[0] ?? days[0]?.date ?? "").slice(0, 10),
    days,
    entries,
  };
}

export function previousWeekUri(data: any): string | null {
  return data?.body?.children?.[0]?.previousButton?.values?.[0]?.uri ?? null;
}

export type Payslip = {
  date: string;
  rate: number | null; // base hourly rate on the newest "Hourly" earnings line
  rateFrom: string;
  rateTo: string;
  gross: number;
  statutory: number;
  other: number;
  net: number;
  earnings: { name: string; dates: string; hours: number | null; rate: number | null; amount: number | null }[];
  deductions: { name: string; amount: number }[];
};

export type Pay = {
  nextPayDate: string | null;
  payslips: { date: string; gross: number | null; net: number | null; view?: string }[];
  history: { period: string; from: string; to: string; earnings: number; deductions: number; net: number }[];
  latest?: Payslip | null;
};

// Grids on a payslip are labelled in French and English, so find them by the fields they hold
function grids(obj: any, out: any[] = []): any[] {
  if (Array.isArray(obj)) obj.forEach((x) => grids(x, out));
  else if (obj && typeof obj === "object") {
    if (obj.widget === "grid") out.push(obj);
    else for (const v of Object.values(obj)) grids(v, out);
  }
  return out;
}

function gridRows(grid: any): Record<string, any>[] {
  const cols: Record<string, string> = {};
  for (const c of grid.columns ?? []) if (c.columnId && c.propertyName) cols[c.columnId] = c.propertyName;
  return (grid.rows ?? []).map((r: any) => {
    const row: Record<string, any> = {};
    for (const [id, cell] of Object.entries<any>(r.cellsMap ?? {})) {
      const v = cell?.value;
      row[cols[id] ?? id] = v && typeof v === "object" ? v.V ?? null : v ?? cell?.instances?.[0]?.text ?? null;
    }
    return row;
  });
}

const hasCol = (g: any, prop: string) => (g.columns ?? []).some((c: any) => c.propertyName === prop);
const num = (v: any) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export function parsePayslip(data: any, date: string): Payslip {
  const all = grids(data?.body);
  const totals = all.find((g) => hasCol(g, "wd:Gross_Amount") && hasCol(g, "wd:Net_Amount"));
  const current = totals ? gridRows(totals).find((r) => !/ytd/i.test(String(r["wd:Payslip_Label_Overrides_for_Current_and_YTD_Balance_Columns"] ?? ""))) : null;
  if (!current) throw new Error("Payslip had no current totals.");

  const earnGrid = all.find((g) => hasCol(g, "wd:Payroll_Hours"));
  const earnings = (earnGrid ? gridRows(earnGrid) : [])
    .filter((r) => r["wd:Earning_Name_with_Retro_Indicator_and_Calculation_Worktag"])
    .map((r) => ({
      name: String(r["wd:Earning_Name_with_Retro_Indicator_and_Calculation_Worktag"]),
      dates: String(r["wd:Formatted_Range_Display_for_Date_parms"] ?? ""),
      hours: num(r["wd:Payroll_Hours"]),
      rate: num(r["wd:Net_Amount_for_Payroll_Result_parm"]),
      amount: num(r["wd:Earnings_Deductions_Amount_aggregated_for_Target_Result_Line_for_Check_Printing"]),
    }));

  // Newest "Hourly" line wins: a mid-period raise shows up as two lines with different rates
  const hourly = earnings
    .filter((e) => /hourly/i.test(e.name) && e.rate)
    .sort((a, b) => (b.dates.match(/\d{4}-\d{2}-\d{2}/g)?.pop() ?? "").localeCompare(a.dates.match(/\d{4}-\d{2}-\d{2}/g)?.pop() ?? ""))[0];
  const range = hourly?.dates.match(/\d{4}-\d{2}-\d{2}/g) ?? [];

  const dedGrid = all.find((g) => /statutory/i.test(g.label ?? "") && hasCol(g, "wd:Pay_Component_Name_with_Authority_code_if_exists"));
  const deductions = (dedGrid ? gridRows(dedGrid) : [])
    .filter((r) => r["wd:Pay_Component_Name_with_Authority_code_if_exists"])
    .map((r) => ({
      name: String(r["wd:Pay_Component_Name_with_Authority_code_if_exists"]),
      amount: num(r["wd:Earnings_Deductions_Amount_aggregated_for_Target_Result_Line_for_Check_Printing"]) ?? 0,
    }));

  return {
    date,
    rate: hourly?.rate ?? null,
    rateFrom: range[0] ?? "",
    rateTo: range[1] ?? "",
    gross: num(current["wd:Gross_Amount"]) ?? 0,
    statutory: num(current["wd:Employee_Tax_Amount"]) ?? 0,
    other: num(current["wd:Post_Tax_Amount"]) ?? 0,
    net: num(current["wd:Net_Amount"]) ?? 0,
    earnings,
    deductions,
  };
}

export function parsePayBatch(batch: any): Pay {
  const out: Pay = { nextPayDate: null, payslips: [], history: [] };
  for (const worklet of batch?.children ?? []) {
    const title = worklet?.title?.text ?? "";
    const widget = worklet?.body?.sections?.[0]?.children?.[0];
    if (!widget) continue;

    if (title === "Recent Payslips") {
      const label: string = widget.columns?.[0]?.label ?? "";
      out.nextPayDate = /(\d{4}-\d{2}-\d{2})/.exec(label)?.[1] ?? null;
      for (const row of widget.rows ?? []) {
        const slip = { date: "", gross: null as number | null, net: null as number | null, view: undefined as string | undefined };
        for (const cell of Object.values<any>(row.cellsMap ?? {})) {
          if (cell?.propertyName === "wd:View" && typeof cell.uri === "string") slip.view = cell.uri;
          else if (cell?.propertyName === "wd:Payment_Date") {
            const v = cell.value;
            slip.date = v?.Y ? `${v.Y}-${v.M}-${v.D}` : String(v ?? "").slice(0, 10);
          } else if (cell?.propertyName === "wd:Gross_Amount") slip.gross = Number(cell.value);
          else if (cell?.propertyName === "wd:Net_Amount") slip.net = Number(cell.value);
        }
        if (slip.date) out.payslips.push(slip);
      }
    } else if (title === "Pay History") {
      const aspects: Record<string, any[]> = {};
      for (const a of widget.aspectData ?? []) aspects[a.name] = a.values ?? [];
      const dedKey = Object.keys(aspects).find((k) => /statutory|gislatives/i.test(k));
      const periods = aspects["Period"] ?? [];
      periods.forEach((p: string, i: number) => {
        const dates = String(p).match(/\d{4}-\d{2}-\d{2}/g) ?? [];
        out.history.push({
          period: String(p).replace(/\s*\(.*\)\s*$/, ""),
          from: dates[0] ?? "",
          to: dates[1] ?? "",
          earnings: Number(aspects["Gains/Earnings"]?.[i] ?? 0),
          deductions: Number(dedKey ? aspects[dedKey][i] : 0),
          net: Number(aspects["Net Pay"]?.[i] ?? 0),
        });
      });
    }
  }
  return out;
}
