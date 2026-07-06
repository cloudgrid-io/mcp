// Root layout + plain inline CSS (no external CDNs, fonts, or stylesheets).
export const metadata = {
  title: "Quiz Platform",
  description: "A persistent quiz/trivia app on CloudGrid, backed by grid-shared Mongo.",
};

const css = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; line-height: 1.5; }
  main { max-width: 42rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { margin: 0 0 .25rem; }
  h2 { margin: 2.5rem 0 .75rem; font-size: 1.15rem; }
  .hint { margin: 0 0 1.5rem; opacity: .7; font-size: .9rem; }
  .card { border: 1px solid #8883; border-radius: .75rem; padding: 1rem 1.15rem; margin-bottom: 1rem; }
  .prompt { font-weight: 600; margin: 0 0 .6rem; }
  .options { list-style: none; padding: 0; margin: 0; display: grid; gap: .4rem; }
  .options li { margin: 0; }
  .opt { display: flex; align-items: center; gap: .55rem; width: 100%; text-align: left;
    padding: .5rem .7rem; border: 1px solid #8886; border-radius: .5rem; background: #6661; font: inherit; cursor: pointer; }
  .opt:hover:not(:disabled) { background: #6663; }
  .opt.selected { border-color: #4a90d9; background: #4a90d933; }
  .opt.correct { border-color: #3ba55d; background: #3ba55d33; }
  .opt.wrong { border-color: #d9534f; background: #d9534f33; }
  .opt:disabled { cursor: default; }
  .row { display: flex; gap: .5rem; margin: .5rem 0; flex-wrap: wrap; }
  input { flex: 1; min-width: 8rem; padding: .5rem .75rem; border: 1px solid #8886; border-radius: .5rem; font: inherit; }
  label.ans { display: flex; align-items: center; gap: .4rem; font-size: .9rem; opacity: .85; }
  button { padding: .5rem .9rem; border: 1px solid #8886; border-radius: .5rem; background: #6663; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: #4a90d9; border-color: #4a90d9; color: #fff; }
  .score { font-size: 1.1rem; font-weight: 600; margin: 1rem 0; }
  .empty { opacity: .6; }
  form.admin { border: 1px dashed #8886; border-radius: .75rem; padding: 1rem 1.15rem; }
  .del { font-size: .8rem; padding: .3rem .55rem; margin-left: auto; }
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
