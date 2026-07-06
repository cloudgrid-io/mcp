import React, { useEffect, useState } from "react";
import * as api from "./api.js";
import SearchView from "./components/SearchView.jsx";
import ManagerLogin from "./components/ManagerLogin.jsx";
import Settings from "./components/Settings.jsx";
import Dashboard from "./components/Dashboard.jsx";

export default function App() {
  const [view, setView] = useState("search");
  const [status, setStatus] = useState(null);
  const [loggedIn, setLoggedIn] = useState(api.isLoggedIn());

  useEffect(() => {
    api.getStatus().then(setStatus).catch(() => setStatus({ mongo: false }));
  }, []);

  function logout() {
    api.setToken(null);
    setLoggedIn(false);
    setView("search");
  }

  return (
    <div className="container">
      <header className="site">
        <h1>Document Search</h1>
        <p>Search across your documents — by word, by meaning, and by date or collection</p>
        <nav className="top">
          <a onClick={() => setView("search")}>Search</a>
          {loggedIn ? (
            <>
              <a onClick={() => setView("settings")}>Settings</a>
              <a onClick={() => setView("dashboard")}>Dashboard</a>
              <a onClick={logout}>Sign out</a>
            </>
          ) : (
            <a onClick={() => setView("login")}>Manager sign-in</a>
          )}
        </nav>
      </header>

      {view === "search" && <SearchView status={status} />}
      {view === "login" && (
        <ManagerLogin
          onLoggedIn={() => {
            setLoggedIn(true);
            setView("settings");
          }}
        />
      )}
      {view === "settings" && loggedIn && <Settings />}
      {view === "dashboard" && loggedIn && <Dashboard />}
    </div>
  );
}
