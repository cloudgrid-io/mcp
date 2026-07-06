// Home page: a server component reads two collections (users + orders) straight
// from Mongo, shows a metrics header (counts + revenue), and hands each resource
// to a client management table (add / delete). Data persists across refresh and
// across users because it lives in the grid-shared Mongo, not in memory.
import { getDb } from "../lib/db.js";
import ResourceTable from "./resource-table.js";

export const dynamic = "force-dynamic";

const USER_ROLES = ["admin", "member", "viewer"];
const ORDER_STATUSES = ["pending", "paid", "shipped"];

async function load() {
  const db = await getDb();
  const [users, orders] = await Promise.all([
    db.collection("users").find({}).sort({ createdAt: -1 }).toArray(),
    db.collection("orders").find({}).sort({ createdAt: -1 }).toArray(),
  ]);
  return {
    users: users.map((u) => ({
      id: u._id.toString(),
      name: u.name || "",
      email: u.email || "",
      role: USER_ROLES.includes(u.role) ? u.role : "member",
    })),
    orders: orders.map((o) => ({
      id: o._id.toString(),
      customer: o.customer || "",
      amount: typeof o.amount === "number" ? o.amount : 0,
      status: ORDER_STATUSES.includes(o.status) ? o.status : "pending",
    })),
  };
}

export default async function Page() {
  const { users, orders } = await load();
  const revenue = orders.reduce((sum, o) => sum + (o.amount || 0), 0);

  return (
    <main>
      <h1>Admin</h1>
      <p className="hint">Persisted in the grid-shared Mongo — survives refresh.</p>

      <div className="metrics">
        <div className="metric"><div className="n">{users.length}</div><div className="l">Users</div></div>
        <div className="metric"><div className="n">{orders.length}</div><div className="l">Orders</div></div>
        <div className="metric"><div className="n">${revenue.toLocaleString()}</div><div className="l">Revenue</div></div>
      </div>

      <h2>Users</h2>
      <ResourceTable
        resource="users"
        columns={[
          { key: "name", label: "Name", input: "text", required: true },
          { key: "email", label: "Email", input: "text" },
          { key: "role", label: "Role", input: "select", options: USER_ROLES },
        ]}
        initialRows={users}
      />

      <h2>Orders</h2>
      <ResourceTable
        resource="orders"
        columns={[
          { key: "customer", label: "Customer", input: "text", required: true },
          { key: "amount", label: "Amount", input: "number" },
          { key: "status", label: "Status", input: "select", options: ORDER_STATUSES },
        ]}
        initialRows={orders}
      />
    </main>
  );
}
