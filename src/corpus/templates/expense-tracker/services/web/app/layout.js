// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Expense Tracker",
  description: "A persistent expense tracker on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  h2 { margin: 2rem 0 .75rem; font-size: 1.1rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  form.row { display: grid; grid-template-columns: 2fr 1fr 1.2fr 1.2fr auto; gap: .5rem; margin-bottom: 1rem; align-items: end; }
  @media (max-width: 40rem) { form.row { grid-template-columns: 1fr 1fr; } }
  label { display: flex; flex-direction: column; gap: .2rem; font-size: .75rem; opacity: .8; }
  input, select { padding: .5rem .6rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; width: 100%; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .55rem .5rem; border-bottom: 1px solid #8883; }
  th { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; opacity: .7; }
  td.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { list-style: none; padding: 0; margin: 0; }
  .totals li { display: flex; justify-content: space-between; padding: .4rem 0; border-bottom: 1px solid #8883; }
  .totals li.grand { font-weight: 600; border-bottom: none; border-top: 2px solid #8886; margin-top: .25rem; }
  .empty { opacity: .6; padding: .6rem 0; }
  .del { background: transparent; border: none; opacity: .6; padding: .2rem .4rem; }
  .del:hover { opacity: 1; }
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
