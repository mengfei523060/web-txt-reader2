/* db.js — IndexedDB 存储层：books 存元数据，texts 存正文 */
"use strict";

const DB = (() => {
  const NAME = "shiguang-reader";
  const VER = 1;
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("books")) db.createObjectStore("books", { keyPath: "id" });
        if (!db.objectStoreNames.contains("texts")) db.createObjectStore("texts", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.onerror = () => reject(t.error);
      if (req) { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); }
      else t.oncomplete = () => resolve();
    }));
  }

  return {
    allBooks:  ()        => tx("books", "readonly", s => s.getAll()),
    getBook:   (id)      => tx("books", "readonly", s => s.get(id)),
    getText:   (id)      => tx("texts", "readonly", s => s.get(id)),
    putBook:   (meta)    => tx("books", "readwrite", s => s.put(meta)),
    putText:   (id, text)=> tx("texts", "readwrite", s => s.put({ id, text })),
    delBook:   (id)      => tx("books", "readwrite", s => s.delete(id))
                           .then(() => tx("texts", "readwrite", s => s.delete(id))),
  };
})();
