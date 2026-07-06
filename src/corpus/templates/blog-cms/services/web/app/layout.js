// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Blog",
  description: "A persistent blog / CMS on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; }
  main { max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  a { color: inherit; }
  h1 { margin: 0 0 .25rem; }
  h1 a { text-decoration: none; }
  .hint { margin: 0 0 2rem; opacity: .7; font-size: .9rem; }
  nav { margin: 0 0 2rem; font-size: .9rem; }
  nav a { margin-right: 1rem; }
  article { padding: 1.25rem 0; border-bottom: 1px solid #8883; }
  article h2 { margin: 0 0 .25rem; font-size: 1.25rem; }
  article h2 a { text-decoration: none; }
  .meta { font-size: .8rem; opacity: .65; margin: 0 0 .5rem; }
  .tags { font-size: .75rem; opacity: .7; }
  .tag { display: inline-block; padding: .1rem .5rem; margin-right: .3rem; border: 1px solid #8886; border-radius: 1rem; }
  .draft { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: #b45; margin-left: .5rem; }
  .empty { opacity: .6; }
  .post-body { white-space: pre-wrap; }
  form.admin { display: grid; gap: .6rem; margin: 1rem 0 2rem; padding: 1.25rem; border: 1px solid #8886; border-radius: .75rem; }
  label { display: grid; gap: .25rem; font-size: .85rem; }
  input, textarea { width: 100%; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; background: transparent; color: inherit; }
  textarea { min-height: 8rem; resize: vertical; }
  .checkbox { display: flex; align-items: center; gap: .5rem; }
  .checkbox input { width: auto; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; color: inherit; }
  button:disabled { opacity: .5; cursor: default; }
  .row-actions button { font-size: .8rem; }
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
