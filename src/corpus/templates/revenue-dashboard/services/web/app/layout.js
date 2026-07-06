// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Revenue Dashboard",
  description: "A persistent revenue/sales dashboard on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 48rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  h2 { font-size: 1rem; margin: 2rem 0 .75rem; opacity: .85; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .total { font-size: 2.5rem; font-weight: 700; margin: .25rem 0 0; }
  .total-label { margin: 0; opacity: .6; font-size: .85rem; text-transform: uppercase; letter-spacing: .05em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .75rem; }
  .card { border: 1px solid #8883; border-radius: .6rem; padding: .75rem .9rem; }
  .card .name { font-weight: 600; }
  .card .amt { opacity: .8; font-variant-numeric: tabular-nums; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: 1rem; }
  input { flex: 1; min-width: 8rem; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .5rem .4rem; border-bottom: 1px solid #8883; }
  td.amt, th.amt { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { opacity: .6; }
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
