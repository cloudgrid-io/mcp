// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Feature Requests",
  description: "A persistent feature request board on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  form.add { display: grid; gap: .5rem; margin: 0 0 2rem; }
  input, textarea, select { padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; width: 100%; }
  textarea { resize: vertical; min-height: 3rem; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { display: flex; align-items: flex-start; gap: .9rem; padding: .9rem 0; border-bottom: 1px solid #8883; }
  li.empty { opacity: .6; display: block; }
  .vote { display: flex; flex-direction: column; align-items: center; gap: .1rem; min-width: 3rem; }
  .vote button { padding: .25rem .55rem; line-height: 1; }
  .vote .count { font-weight: 600; font-variant-numeric: tabular-nums; }
  .body { flex: 1; }
  .title { font-weight: 600; }
  .desc { opacity: .8; font-size: .92rem; margin: .15rem 0 0; }
  .status { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; padding: .1rem .5rem; border-radius: 1rem; border: 1px solid #8886; opacity: .85; }
  .status.open { }
  .status.planned { background: #6cf3; }
  .status.done { background: #6c63; }
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
