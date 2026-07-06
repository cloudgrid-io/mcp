// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Financial Dashboard",
  description: "A persistent P&L / cashflow board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .totals { display: grid; grid-template-columns: repeat(3, 1fr); gap: .75rem; margin-bottom: 1.5rem; }
  .card { border: 1px solid #8886; border-radius: .75rem; padding: 1rem; }
  .card .label { font-size: .8rem; opacity: .7; text-transform: uppercase; letter-spacing: .04em; }
  .card .value { font-size: 1.5rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .value.income { color: #16a34a; }
  .value.expense { color: #dc2626; }
  .value.net.pos { color: #16a34a; }
  .value.net.neg { color: #dc2626; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; }
  input.account { flex: 1; min-width: 8rem; }
  input.amount { width: 8rem; font-variant-numeric: tabular-nums; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #8883; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; opacity: .65; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.income { color: #16a34a; }
  td.expense { color: #dc2626; }
  tr.empty td { opacity: .6; text-align: left; }
`;

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
