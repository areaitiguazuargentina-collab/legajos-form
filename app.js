import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore, addDoc, collection, serverTimestamp,
  query, orderBy, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword,
  onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/** ===== Validación tokens =====
 * Legajo: 0..9999 (1..4 dígitos, acepta 0)
 * Empresa: C1..C99 (cantidad personas)
 */
const MAX_LEGAJO_DIGITS = 4;
const MAX_C = 99;
const MIN_C = 1;

const RE_LEGAJO = /^\d{1,4}$/;
const RE_CTOKEN = /^C([1-9]\d{0,1})$/i;

function canonicalizeLegajoDigits(d) {
  const s = d.replace(/^0+/, "");
  return s === "" ? "0" : s;
}
function canonicalizeCToken(tok) {
  const m = String(tok).trim().match(RE_CTOKEN);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < MIN_C || n > MAX_C) return null;
  return `C${n}`;
}
function parseTokens(raw) {
  const tokens = String(raw || "")
    .split(/[,\s;]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const ok = [];
  const bad = [];

  for (const t of tokens) {
    const cTok = canonicalizeCToken(t);
    if (cTok) {
      if (!seen.has(cTok)) { seen.add(cTok); ok.push(cTok); }
      continue;
    }

    const onlyDigits = t.replace(/\D/g, "");
    if (!onlyDigits || onlyDigits.length > MAX_LEGAJO_DIGITS || !RE_LEGAJO.test(onlyDigits)) {
      bad.push(t);
      continue;
    }

    const canon = canonicalizeLegajoDigits(onlyDigits);
    if (!seen.has(canon)) { seen.add(canon); ok.push(canon); }
  }

  return { ok, bad };
}
function empresaCTotal(tokensOk) {
  return tokensOk
    .filter(x => /^C\d+$/.test(x))
    .reduce((sum, x) => sum + Number(x.slice(1)), 0);
}

/** ===== UI helpers ===== */
const $ = (id) => document.getElementById(id);

const frmIngreso = $("frmIngreso");
const inputTokens = $("tokens");
const btnIngreso = $("btnIngreso");
const btnLimpiar = $("btnLimpiar");
const msgPublic = $("msgPublic");
const preview = $("preview");

const frmAdminLogin = $("frmAdminLogin");
const adminEmail = $("adminEmail");
const adminPass = $("adminPass");
const btnAdminLogin = $("btnAdminLogin");
const btnAdminLogout = $("btnAdminLogout");
const msgAdmin = $("msgAdmin");

const adminPanelSection = $("adminPanelSection");
const btnCargar = $("btnCargar");
const btnExportar = $("btnExportar");
const tblBody = $("tbl").querySelector("tbody");

function setMsg(el, text, type) {
  el.textContent = text || "";
  el.className = "msg " + (type || "");
}

function refreshPreview() {
  const { ok, bad } = parseTokens(inputTokens.value);
  const cTot = empresaCTotal(ok);
  preview.textContent =
    `OK (${ok.length}): ${ok.join(", ")}\n` +
    `Empresa C total: ${cTot}\n` +
    (bad.length ? `\nINVALIDOS (${bad.length}): ${bad.join(", ")}` : "");
}

inputTokens.addEventListener("input", refreshPreview);
btnLimpiar.addEventListener("click", () => {
  inputTokens.value = "";
  refreshPreview();
  setMsg(msgPublic, "", "");
  inputTokens.focus();
});

/** ===== Firebase init ===== */
if (!window.FIREBASE_CONFIG) {
  setMsg(msgPublic, "Falta firebase-config.js (window.FIREBASE_CONFIG).", "err");
  btnIngreso.disabled = true;
  throw new Error("Missing FIREBASE_CONFIG");
}
const app = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(app);
const auth = getAuth(app);

// Mantener sesión anónima para que pueda escribir (y Rules lo permitan)
async function ensureAnon() {
  if (!auth.currentUser) {
    await signInAnonymously(auth);
  }
}
await ensureAnon();

refreshPreview();

/** ===== SUBMIT PUBLICO ===== */
frmIngreso.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgPublic, "", "");
  btnIngreso.disabled = true;

  try {
    await ensureAnon();

    const raw = inputTokens.value;
    const { ok, bad } = parseTokens(raw);

    if (ok.length === 0) return setMsg(msgPublic, "No hay tokens válidos. Ej: 0,22,1162,C5", "err");
    if (bad.length) return setMsg(msgPublic, `Tokens inválidos: ${bad.join(", ")}`, "err");
    if (ok.length > 50) return setMsg(msgPublic, "Máx 50 tokens por envío.", "err");

    const cTotal = empresaCTotal(ok);

    await addDoc(collection(db, "registros_legajos"), {
      createdAt: serverTimestamp(),
      raw,
      tokens: ok,
      empresaC: cTotal,
      count: ok.length,
      uid: auth.currentUser?.uid || null,
      ua: navigator.userAgent,
    });

    setMsg(msgPublic, `OK guardado. Empresa C total: ${cTotal}`, "ok");
    inputTokens.value = "";
    refreshPreview();
    inputTokens.focus();
  } catch (err) {
    console.error(err);
    setMsg(msgPublic, "Error guardando (revisá Rules / Auth).", "err");
  } finally {
    btnIngreso.disabled = false;
  }
});

/** ===== ADMIN LOGIN ===== */
frmAdminLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgAdmin, "", "");

  try {
    btnAdminLogin.disabled = true;
    await signInWithEmailAndPassword(auth, adminEmail.value.trim(), adminPass.value);
    setMsg(msgAdmin, "OK. Logueado.", "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, "Login falló. Revisá usuario/clave y que Email/Password esté habilitado.", "err");
  } finally {
    btnAdminLogin.disabled = false;
  }
});

btnAdminLogout.addEventListener("click", async () => {
  await signOut(auth);
});

/** ===== Mostrar/ocultar panel según user ===== */
let lastRows = []; // cache para exportar

onAuthStateChanged(auth, (user) => {
  // Si es un user email/password, suele tener providerData con "password"
  const isPasswordUser = !!user?.providerData?.some(p => p.providerId === "password");

  adminPanelSection.style.display = isPasswordUser ? "block" : "none";
  btnAdminLogout.style.display = user ? "inline-block" : "none";

  if (!user) {
    // vuelve a anónimo para que el público siga funcionando sin tocar nada
    ensureAnon().catch(() => {});
  }
});

/** ===== ADMIN: cargar últimos 500 ===== */
btnCargar.addEventListener("click", async () => {
  setMsg(msgAdmin, "", "");
  tblBody.innerHTML = "";
  lastRows = [];

  try {
    const q = query(collection(db, "registros_legajos"), orderBy("createdAt", "desc"), limit(500));
    const snap = await getDocs(q);

    snap.forEach((doc) => {
      const d = doc.data();
      const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
      const fecha = createdAt ? createdAt.toLocaleString() : "";

      const row = {
        fecha_hora: fecha,
        tokens: (d.tokens || []).join(" "),
        empresaC: d.empresaC ?? 0,
        raw: d.raw ?? "",
        uid: d.uid ?? "",
      };
      lastRows.push(row);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.fecha_hora)}</td>
        <td>${escapeHtml(row.tokens)}</td>
        <td>${escapeHtml(String(row.empresaC))}</td>
        <td>${escapeHtml(row.raw)}</td>
        <td>${escapeHtml(row.uid)}</td>
      `;
      tblBody.appendChild(tr);
    });

    setMsg(msgAdmin, `Cargados: ${lastRows.length}`, "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, "No pude leer registros. Revisá Rules (UID admin).", "err");
  }
});

/** ===== ADMIN: export a Excel ===== */
btnExportar.addEventListener("click", () => {
  if (!lastRows.length) return setMsg(msgAdmin, "Primero cargá datos.", "err");

  // lastRows: [{fecha_hora, tokens, empresaC, raw, uid}]  (cache)
  // Queremos exportar: FechaHora (sin segundos) + Token (1 por fila)

  const filas = [];

  for (const r of lastRows) {
    // r.tokens viene como "1162 0 1 C2" (por como lo armamos)
    const tokens = String(r.tokens || "")
      .split(/\s+/g)
      .map(s => s.trim())
      .filter(Boolean);

    // Formato dd/mm/aaaa hh:mm (sin segundos)
    const fechaHora = String(r.fecha_hora || "");
    // Si tu fecha_hora ya viene sin segundos, perfecto.
    // Si viene con segundos, recortamos al minuto:
    const fechaHoraMin = recortarASoloMinutos(fechaHora);

    for (const t of tokens) {
      filas.push({
        "FechaHora": fechaHoraMin,
        "Legajo": t
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(filas, { header: ["FechaHora", "Legajo"] });

  // (Opcional) Ancho de columnas
  ws["!cols"] = [{ wch: 20 }, { wch: 12 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Registros");

  const filename = `control_colectivos_${new Date().toISOString().slice(0,10)}.xlsx`;
  XLSX.writeFile(wb, filename, { compression: true });
  setMsg(msgAdmin, `Exportado: ${filename} (${filas.length} filas)`, "ok");
});

function recortarASoloMinutos(fechaHoraStr) {
  // Intenta recortar cosas como "01/02/2026 07:08:11" -> "01/02/2026 07:08"
  // o "1/2/2026, 7:08:11" -> "1/2/2026, 7:08"
  // Si no encuentra patrón, devuelve el original.
  const s = String(fechaHoraStr || "").trim();

  // patrón flexible: HH:MM:SS -> HH:MM
  const m = s.match(/^(.*\b\d{1,2}:\d{2})(?::\d{2})\b(.*)$/);
  if (m) return (m[1] + (m[2] || "")).trim();

  return s;
}

/** util */
function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
