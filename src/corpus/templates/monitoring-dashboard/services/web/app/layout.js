// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Monitoring Dashboard",
  description: "A service health board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 52rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  h2 { margin: 2rem 0 .75rem; font-size: 1.1rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  form.row { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1rem; align-items: center; }
  input, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  input.service { flex: 1; min-width: 10rem; }
  input.latency { width: 8rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .75rem; }
  .card { border: 1px solid #8884; border-radius: .6rem; padding: .8rem .9rem; }
  .card .name { font-weight: 600; }
  .card .meta { font-size: .85rem; opacity: .7; margin-top: .2rem; }
  .badge { display: inline-block; padding: .1rem .5rem; border-radius: 1rem; font-size: .75rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
  .badge.up { background: #1f8f4922; color: #1f8f49; }
  .badge.degraded { background: #b9770022; color: #b97700; }
  .badge.down { background: #c0392b22; color: #c0392b; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .45rem .5rem; border-bottom: 1px solid #8883; }
  th { font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; opacity: .7; }
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
