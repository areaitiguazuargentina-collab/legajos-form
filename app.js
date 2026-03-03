import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  addDoc,
  collection,
  serverTimestamp,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  doc,
  setDoc,
  updateDoc,
  getDoc
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

/**
 * MODELO NUEVO:
 * - legajos_activos/{legajo} -> { activo: true/false, nombre, updatedAt }
 * - registros_tokens/{autoId} -> { createdAt, token, tipo, cantidadC, raw, uid }
 *
 * Validación:
 * - Legajo: 0..9999 (1..4 dígitos). Normaliza ceros a la izquierda: 0012 -> 12. "0000" -> "0"
 * - Empresa: C1..C99 (cualquiera en minúscula se normaliza a C#)
 * - Si es legajo y NO es "0": debe existir en legajos_activos y activo==true
 */

const MAX_INPUT_LEN = 300;
const MAX_TOKENS_PER_SUBMIT = 50;

const MIN_C = 1;
const MAX_C = 99;

// ======================
// Helpers UI
// ======================
const $ = (id) => document.getElementById(id);

const frmIngreso = $("frmIngreso");
const inputTokens = $("tokens");
const btnIngreso = $("btnIngreso");
const btnLimpiar = $("btnLimpiar");
const msgPublic = $("msgPublic");
const preview = $("preview");

// Admin login
const frmAdminLogin = $("frmAdminLogin");
const adminEmail = $("adminEmail");
const adminPass = $("adminPass");
const btnAdminLogin = $("btnAdminLogin");
const btnAdminLogout = $("btnAdminLogout");
const msgAdmin = $("msgAdmin");

// Admin panel
const adminPanelSection = $("adminPanelSection");
const mesInput = $("mes");
const btnCargarMes = $("btnCargarMes");
const btnExportarMes = $("btnExportarMes");
const tblBody = $("tbl").querySelector("tbody");

// ABM legajos
const nuevoLegajo = $("nuevoLegajo");
const nombreLegajo = $("nombreLegajo");
const btnAgregarLegajo = $("btnAgregarLegajo");
const btnCargarLegajos = $("btnCargarLegajos");
const msgLegajos = $("msgLegajos");
const tblLegajosBody = $("tblLegajos").querySelector("tbody");

function setMsg(el, text, type) {
  el.textContent = text || "";
  el.className = "msg " + (type || "");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ======================
// Firebase init
// ======================
if (!window.FIREBASE_CONFIG) {
  setMsg(msgPublic, "Falta firebase-config.js (window.FIREBASE_CONFIG).", "err");
  btnIngreso.disabled = true;
  throw new Error("Missing FIREBASE_CONFIG");
}

const app = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(app);
const auth = getAuth(app);

// Mantener sesión anónima para la carga pública
async function ensureAnon() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

// ======================
// Parse / Validación
// ======================
const RE_CTOKEN = /^C([1-9]\d{0,1})$/i;

function canonicalizeLegajoDigits(d) {
  const s = String(d).replace(/^0+/, "");
  return s === "" ? "0" : s;
}

function canonicalizeCToken(tok) {
  const m = String(tok).trim().match(RE_CTOKEN);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n < MIN_C || n > MAX_C) return null;
  return `C${n}`;
}

function isValidLegajoCanon(canon) {
  // canon: "0" o "1".."9999" sin ceros a la izquierda
  if (canon === "0") return true;
  if (!/^[1-9]\d{0,3}$/.test(canon)) return false;
  const n = Number(canon);
  return Number.isInteger(n) && n >= 1 && n <= 9999;
}

function parseTokens(raw) {
  const tokens = String(raw || "")
    .slice(0, MAX_INPUT_LEN)
    .split(/[,\s;]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const ok = [];
  const bad = [];

  for (const t of tokens) {
    // C#
    const cTok = canonicalizeCToken(t);
    if (cTok) {
      if (!seen.has(cTok)) { seen.add(cTok); ok.push(cTok); }
      continue;
    }

    // legajo: extraer solo dígitos
    const onlyDigits = t.replace(/\D/g, "");
    if (!onlyDigits || onlyDigits.length > 4) {
      bad.push(t);
      continue;
    }

    const canon = canonicalizeLegajoDigits(onlyDigits);
    if (!isValidLegajoCanon(canon)) {
      bad.push(t);
      continue;
    }

    if (!seen.has(canon)) { seen.add(canon); ok.push(canon); }
  }

  return { ok, bad };
}

function empresaCTotal(tokensOk) {
  return tokensOk
    .filter(x => /^C\d+$/.test(x))
    .reduce((sum, x) => sum + Number(x.slice(1)), 0);
}

// ======================
// Legajos activos cache (para validar "no existe")
// ======================
let legajosActivosSet = new Set();   // solo legajos activos (string canon)
let legajosActivosLoadedAt = 0;

async function loadLegajosActivos({ force = false } = {}) {
  // cache 2 min por defecto
  const now = Date.now();
  if (!force && now - legajosActivosLoadedAt < 2 * 60 * 1000 && legajosActivosSet.size > 0) {
    return legajosActivosSet;
  }

  // Traer activos
  // Nota: Si tenés MUCHOS (miles), habrá que paginar, pero para ~400 va perfecto.
  const q = query(
    collection(db, "legajos_activos"),
    where("activo", "==", true),
    limit(5000)
  );

  const snap = await getDocs(q);
  const s = new Set();
  snap.forEach((d) => {
    const id = d.id; // docId = legajo canon
    if (isValidLegajoCanon(id)) s.add(id);
  });

  legajosActivosSet = s;
  legajosActivosLoadedAt = now;
  return legajosActivosSet;
}

// ======================
// Preview público
// ======================
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

// ======================
// Guardar ingreso (público)
// ======================
frmIngreso.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgPublic, "", "");
  btnIngreso.disabled = true;

  try {
    await ensureAnon();

    const raw = inputTokens.value;
    const { ok, bad } = parseTokens(raw);

    if (ok.length === 0) {
      setMsg(msgPublic, "No hay tokens válidos. Ej: 0,22,1162,C5", "err");
      return;
    }
    if (bad.length) {
      setMsg(msgPublic, `Tokens inválidos: ${bad.join(", ")}`, "err");
      return;
    }
    if (ok.length > MAX_TOKENS_PER_SUBMIT) {
      setMsg(msgPublic, `Máximo ${MAX_TOKENS_PER_SUBMIT} tokens por envío.`, "err");
      return;
    }

    // Validación existencia legajos (no aplica a C# y no aplica al "0")
    const activos = await loadLegajosActivos();
    const legajosNoExisten = ok.filter(t => /^[0-9]+$/.test(t) && t !== "0" && !activos.has(t));

    if (legajosNoExisten.length) {
      setMsg(msgPublic, `Estás ingresando legajos que no existen: ${legajosNoExisten.join(", ")}`, "err");
      return;
    }

    const uid = auth.currentUser?.uid || null;

    // Guardamos 1 doc por token (mejor para export y rules)
    const writes = ok.map((t) => {
      const isC = /^C\d+$/.test(t);
      const cantidadC = isC ? Number(t.slice(1)) : 0;

      return addDoc(collection(db, "registros_tokens"), {
        createdAt: serverTimestamp(),
        token: t,
        tipo: isC ? "C" : "LEGAJO",
        cantidadC,
        raw,
        uid,
      });
    });

    await Promise.all(writes);

    setMsg(msgPublic, `OK guardado (${ok.length}).`, "ok");
    inputTokens.value = "";
    refreshPreview();
    inputTokens.focus();
  } catch (err) {
    console.error(err);
    setMsg(msgPublic, "Error guardando. Revisá Rules / Auth.", "err");
  } finally {
    btnIngreso.disabled = false;
  }
});

// ======================
// Admin Auth
// ======================
frmAdminLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgAdmin, "", "");

  try {
    btnAdminLogin.disabled = true;
    await signInWithEmailAndPassword(auth, adminEmail.value.trim(), adminPass.value);
    setMsg(msgAdmin, "OK. Logueado.", "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, "Login falló. Revisá usuario/clave.", "err");
  } finally {
    btnAdminLogin.disabled = false;
  }
});

btnAdminLogout.addEventListener("click", async () => {
  await signOut(auth);
});

// mostrar/ocultar panel
onAuthStateChanged(auth, async (user) => {
  const isPasswordUser = !!user?.providerData?.some(p => p.providerId === "password");

  adminPanelSection.style.display = isPasswordUser ? "block" : "none";
  btnAdminLogout.style.display = user ? "inline-block" : "none";

  if (!user) {
    // volver a anónimo para que público funcione
    try { await ensureAnon(); } catch {}
  }
});

// ======================
// Export por mes (admin)
// ======================
setMesActual();

function setMesActual() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  mesInput.value = `${d.getFullYear()}-${mm}`;
}

function getMonthRange(yyyyMm) {
  const [y, m] = yyyyMm.split("-").map(Number);
  const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const end = new Date(y, m, 1, 0, 0, 0, 0);
  return { start, end };
}

function formatFechaHoraMin(dateObj) {
  // dd/mm/aaaa hh:mm (sin segundos) para AR
  return dateObj.toLocaleString("es-AR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

let lastMonthRows = []; // cache para export

async function cargarRegistrosDelMes(yyyyMm) {
  const { start, end } = getMonthRange(yyyyMm);

  // Puede pedir índice la primera vez; Firestore te da un link.
  const q = query(
    collection(db, "registros_tokens"),
    where("createdAt", ">=", start),
    where("createdAt", "<", end),
    orderBy("createdAt", "asc"),
    limit(20000)
  );

  const snap = await getDocs(q);
  const rows = [];

  snap.forEach((docu) => {
    const d = docu.data();
    const createdAt = d.createdAt?.toDate ? d.createdAt.toDate() : null;
    const fecha = createdAt ? formatFechaHoraMin(createdAt) : "";
    rows.push({
      FechaHora: fecha,
      Legajo: d.token ?? ""
    });
  });

  return rows;
}

btnCargarMes.addEventListener("click", async () => {
  setMsg(msgAdmin, "", "");
  tblBody.innerHTML = "";
  lastMonthRows = [];

  try {
    const yyyyMm = mesInput.value;
    if (!yyyyMm) return setMsg(msgAdmin, "Elegí un mes.", "err");

    lastMonthRows = await cargarRegistrosDelMes(yyyyMm);

    for (const r of lastMonthRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(r.FechaHora)}</td>
        <td>${escapeHtml(r.Legajo)}</td>
      `;
      tblBody.appendChild(tr);
    }

    setMsg(msgAdmin, `Cargados ${lastMonthRows.length} registros del mes ${yyyyMm}.`, "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, "No pude cargar el mes. (Puede requerir índice).", "err");
  }
});

btnExportarMes.addEventListener("click", async () => {
  setMsg(msgAdmin, "", "");

  try {
    const yyyyMm = mesInput.value;
    if (!yyyyMm) return setMsg(msgAdmin, "Elegí un mes.", "err");

    if (!lastMonthRows.length) {
      lastMonthRows = await cargarRegistrosDelMes(yyyyMm);
    }
    if (!lastMonthRows.length) return setMsg(msgAdmin, "No hay datos para ese mes.", "err");

    const ws = XLSX.utils.json_to_sheet(lastMonthRows, { header: ["FechaHora", "Legajo"] });
    ws["!cols"] = [{ wch: 20 }, { wch: 12 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Registros");

    const filename = `control_colectivos_${yyyyMm}.xlsx`;
    XLSX.writeFile(wb, filename, { compression: true });

    setMsg(msgAdmin, `Exportado: ${filename} (${lastMonthRows.length} filas)`, "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgAdmin, "Error exportando (puede requerir índice).", "err");
  }
});

// ======================
// ABM Legajos (admin)
// ======================
function canonLegajoFromInput(v) {
  const onlyDigits = String(v || "").replace(/\D/g, "");
  if (!onlyDigits || onlyDigits.length > 4) return null;
  const canon = canonicalizeLegajoDigits(onlyDigits);
  if (!isValidLegajoCanon(canon)) return null;
  return canon;
}

btnAgregarLegajo.addEventListener("click", async () => {
  setMsg(msgLegajos, "", "");

  try {
    const canon = canonLegajoFromInput(nuevoLegajo.value);
    if (!canon) return setMsg(msgLegajos, "Legajo inválido (0..9999).", "err");

    // opcional: no permitir 0 en ABM (porque 0 lo dejamos siempre permitido)
    // si querés permitirlo igual, borrá este if.
    if (canon === "0") return setMsg(msgLegajos, "El legajo 0 no se administra (siempre permitido).", "err");

    const nombre = String(nombreLegajo.value || "").trim().slice(0, 60);

    await setDoc(doc(db, "legajos_activos", canon), {
      activo: true,
      nombre,
      updatedAt: serverTimestamp()
    }, { merge: true });

    // refrescar cache para validación pública
    await loadLegajosActivos({ force: true });

    setMsg(msgLegajos, `OK. Legajo ${canon} activado.`, "ok");
    nuevoLegajo.value = "";
    nombreLegajo.value = "";
  } catch (err) {
    console.error(err);
    setMsg(msgLegajos, "Error agregando/activando legajo (revisá Rules admin).", "err");
  }
});

btnCargarLegajos.addEventListener("click", async () => {
  setMsg(msgLegajos, "", "");
  tblLegajosBody.innerHTML = "";

  try {
    // Traemos hasta 5000 docs (si tenés más, se pagina)
    const q = query(collection(db, "legajos_activos"), orderBy("activo", "desc"), limit(5000));
    const snap = await getDocs(q);

    snap.forEach((d) => {
      const data = d.data();
      const leg = d.id;
      const nombre = data.nombre ?? "";
      const activo = !!data.activo;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(leg)}</td>
        <td>${escapeHtml(nombre)}</td>
        <td>${activo ? "Sí" : "No"}</td>
        <td>
          <button data-leg="${escapeHtml(leg)}" class="secondary btnDesactivar">Desactivar</button>
        </td>
      `;
      tblLegajosBody.appendChild(tr);
    });

    // bind desactivar
    tblLegajosBody.querySelectorAll(".btnDesactivar").forEach(btn => {
      btn.addEventListener("click", async () => {
        const leg = btn.getAttribute("data-leg");
        if (!leg) return;

        try {
          await updateDoc(doc(db, "legajos_activos", leg), {
            activo: false,
            updatedAt: serverTimestamp()
          });

          await loadLegajosActivos({ force: true });
          setMsg(msgLegajos, `OK. Legajo ${leg} desactivado.`, "ok");
          btnCargarLegajos.click(); // recargar tabla
        } catch (err) {
          console.error(err);
          setMsg(msgLegajos, "No pude desactivar (revisá Rules admin).", "err");
        }
      });
    });

    setMsg(msgLegajos, "Listado cargado.", "ok");
  } catch (err) {
    console.error(err);
    setMsg(msgLegajos, "Error cargando legajos (revisá Rules admin).", "err");
  }
});

// ======================
// Init
// ======================
(async function init() {
  try {
    await ensureAnon();
    // Pre-cargar legajos activos para validar rápido (si no hay ninguno, igual deja cargar C# y 0)
    await loadLegajosActivos({ force: true });
  } catch {}
  refreshPreview();
})();
