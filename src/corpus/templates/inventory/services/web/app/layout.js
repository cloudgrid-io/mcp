// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Inventory",
  description: "A persistent inventory / stock tracker on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 60rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  input { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; flex: 1; min-width: 6rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.step { padding: .2rem .55rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .6rem .5rem; border-bottom: 1px solid #8883; vertical-align: middle; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; opacity: .7; }
  td.qty { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .low { font-size: .75rem; padding: .1rem .45rem; border: 1px solid #c0392b88; color: #c0392b; border-radius: 1rem; margin-left: .4rem; }
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
