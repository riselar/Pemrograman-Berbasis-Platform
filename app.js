const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bodyParser = require("body-parser");
const cors = require("cors");

const db = new sqlite3.Database("./books.db");
const app = express();
app.use(cors());
app.use(bodyParser.json());

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author TEXT,
    stock INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    qty INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now')),
    confirmed_at TEXT,
    FOREIGN KEY(book_id) REFERENCES books(id)
  )`);
});

app.post("/books", (req, res) => {
  const { title, author = null, stock = 0 } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  if (!Number.isInteger(stock) || stock < 0)
    return res.status(400).json({ error: "invalid stock" });

  const s = db.prepare(
    "INSERT INTO books (title, author, stock) VALUES (?, ?, ?)"
  );
  s.run(title, author, stock, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    db.get("SELECT * FROM books WHERE id = ?", [this.lastID], (e, row) =>
      res.status(201).json(row)
    );
  });
});

app.get("/books", (req, res) => {
  const q = req.query.q ? `%${req.query.q}%` : null;
  let sql = "SELECT * FROM books";
  const p = [];
  if (q) {
    sql += " WHERE title LIKE ? OR author LIKE ?";
    p.push(q, q);
  }
  sql += " ORDER BY id DESC";
  db.all(sql, p, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get("/books/:id", (req, res) => {
  db.get("SELECT * FROM books WHERE id = ?", [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  });
});

app.put("/books/:id", (req, res) => {
  const { title, author, stock } = req.body;
  if (stock !== undefined && (!Number.isInteger(stock) || stock < 0))
    return res.status(400).json({ error: "invalid stock" });

  db.get("SELECT * FROM books WHERE id = ?", [req.params.id], (err, book) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!book) return res.status(404).json({ error: "not found" });

    const t = title !== undefined ? title : book.title;
    const a = author !== undefined ? author : book.author;
    const s = stock !== undefined ? stock : book.stock;

    db.run(
      "UPDATE books SET title=?, author=?, stock=? WHERE id=?",
      [t, a, s, req.params.id],
      () =>
        db.get("SELECT * FROM books WHERE id=?", [req.params.id], (_, row) =>
          res.json(row)
        )
    );
  });
});

app.post("/orders", (req, res) => {
  const { book_id, qty } = req.body;
  if (!book_id) return res.status(400).json({ error: "book_id required" });
  if (!Number.isInteger(qty) || qty <= 0)
    return res.status(400).json({ error: "invalid qty" });

  db.get("SELECT * FROM books WHERE id=?", [book_id], (err, book) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!book) return res.status(404).json({ error: "book not found" });

    const s = db.prepare(
      "INSERT INTO orders (book_id, qty, status) VALUES (?, ?, ?)"
    );
    s.run(book_id, qty, "pending", function (e) {
      if (e) return res.status(500).json({ error: e.message });
      db.get("SELECT * FROM orders WHERE id=?", [this.lastID], (_, row) =>
        res.status(201).json(row)
      );
    });
  });
});

app.post("/orders/:id/confirm", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM orders WHERE id=?", [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "order not found" });
    if (order.status !== "pending")
      return res.status(400).json({ error: "already processed" });

    db.get("SELECT * FROM books WHERE id=?", [order.book_id], (e, book) => {
      if (e) return res.status(500).json({ error: e.message });
      if (!book) return res.status(500).json({ error: "book missing" });
      if (book.stock < order.qty)
        return res
          .status(400)
          .json({ error: "insufficient stock", stock: book.stock });

      db.run(
        "UPDATE books SET stock = stock - ? WHERE id=?",
        [order.qty, book.id],
        () =>
          db.run(
            "UPDATE orders SET status='confirmed', confirmed_at=datetime('now') WHERE id=?",
            [id],
            () =>
              db.get("SELECT * FROM orders WHERE id=?", [id], (_, row) =>
                res.json({
                  order: row,
                  remaining_stock: book.stock - order.qty,
                })
              )
          )
      );
    });
  });
});

app.post("/orders/:id/cancel", (req, res) => {
  const id = req.params.id;
  db.get("SELECT * FROM orders WHERE id=?", [id], (err, order) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!order) return res.status(404).json({ error: "not found" });
    if (order.status !== "pending")
      return res.status(400).json({ error: "cannot cancel" });

    db.run("UPDATE orders SET status='cancelled' WHERE id=?", [id], () =>
      db.get("SELECT * FROM orders WHERE id=?", [id], (_, row) => res.json(row))
    );
  });
});

app.get("/orders", (req, res) => {
  db.all(
    "SELECT o.*, b.title book_title, b.author book_author FROM orders o JOIN books b ON o.book_id = b.id ORDER BY o.id DESC",
    [],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.get("/orders/:id", (req, res) => {
  db.get(
    "SELECT o.*, b.title book_title FROM orders o JOIN books b ON o.book_id=b.id WHERE o.id=?",
    [req.params.id],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: "not found" });
      res.json(row);
    }
  );
});

app.listen(3000, () => console.log("running"));
