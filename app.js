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
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

const MAX_INPUT_LEN = 300;
const MAX_TOKENS_PER_SUBMIT = 50;
const MIN_C = 1;
const MAX_C = 99;

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
const mesInput = $("mes");
const btnCargarMes = $("btnCargarMes");
const btnExportarMes = $("btnExportarMes");
const tblBody = $("tbl").querySelector("tbody");

const nuevoLegajo = $("nuevoLegajo");
const nombreLegajo = $("nombreLegajo");
const btnAgregarLegajo = $("btnAgregarLegajo");
const btnCargarLegajos = $("btnCargarLegajos");
const msgLegajos = $("msgLegajos");
const tblLegajosBody = $("tblLegajos").querySelector("tbody");

// Import masivo
const btnUnlockImport = $("btnUnlockImport");
const importHint = $("importHint");
const importBox = $("importBox");
const bulkLegajos = $("bulkLegajos");
const btnImportarLegajos = $("btnImportarLegajos");
const btnCancelarImport = $("btnCancelarImport");
const msgImport = $("msgImport");

function setMsg(el, text, type) {
  if (!el) return;
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

// Firebase init
if (!window.FIREBASE_CONFIG) {
  setMsg(msgPublic, "Falta firebase-config.js (window.FIREBASE_CONFIG).", "err");
  btnIngreso.disabled = true;
  throw new Error("Missing FIREBASE_CONFIG");
}

const app = initializeApp(window.FIREBASE_CONFIG);
const db = getFirestore(app);
const auth = getAuth(app);

async function ensureAnon() {
  if (!auth.currentUser) await signInAnonymously(auth);
}

// ===== Parse / Validación =====
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
  if (canon === "0") return true;
  if (!/^[1-9]\d{0,3}$/.test(canon)) return false;
  const n = Number(canon);
  return Number.isInteger(n) && n >= 1 && n <= 9999;
}

function parseTokens(raw) {
  // Soporta copiar/pegar desde Excel:
  // - saltos de línea
  // - tabs
  // - comas, punto y coma, espacios
  const tokens = String(raw || "")
    .slice(0, MAX_INPUT_LEN)
    .split(/[,\s;\t\r\n]+/g)
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

    // legajo: solo dígitos
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

// ===== Legajos activos cache (validación "no existe") =====
let legajosActivosSet = new Set();
let legajosActivosLoadedAt = 0;

async function loadLegajosActivos({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - legajosActivosLoadedAt < 2 * 60 * 1000 && legajosActivosSet.size > 0) {
    return legajosActivosSet;
  }

  const q = query(
    collection(db, "legajos_activos"),
    where("activo", "==", true),
    limit(5000)
  );

  const snap = await getDocs(q);
  const s = new Set();
  snap.forEach((d) => {
    const id = d.id;
    if (isValidLegajoCanon(id)) s.add(id);
  });

  legajosActivosSet = s;
  legajosActivosLoadedAt = now;
  return legajosActivosSet;
}

// ===== Preview =====
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

// ===== Guardar ingreso =====
frmIngreso.addEventListener("submit", async (e) => {
  e.preventDefault();
  setMsg(msgPublic, "", "");
  btnIngreso.disabled = true;

  try {
    await ensureAnon();

    const raw = inputTokens.value;
    const { ok, bad } = parseTokens(raw);

    if (ok.length === 0) {
      setMsg(msgPublic, "No hay legajos válidos.", "err");
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

    // Guardamos 1 doc por token
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

// ===== Admin Auth =====
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

onAuthStateChanged(auth, async (user) => {
  const isPasswordUser = !!user?.providerData?.some(p => p.providerId === "password");
  adminPanelSection.style.display = isPasswordUser ? "block" : "none";
  btnAdminLogout.style.display = user ? "inline-block" : "none";

  if (!user) {
    try { await ensureAnon(); } catch {}
  }
});

// ===== Export por mes =====
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
  return dateObj.toLocaleString("es-AR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

let lastMonthRows = [];

async function cargarRegistrosDelMes(yyyyMm) {
  const { start, end } = getMonthRange(yyyyMm);

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

// ===== ABM Legajos =====
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
    if (canon === "0") return setMsg(msgLegajos, "El legajo 0 no se administra (siempre permitido).", "err");

    const nombre = String(nombreLegajo.value || "").trim().slice(0, 60);

    await setDoc(doc(db, "legajos_activos", canon), {
      activo: true,
      nombre,
      updatedAt: serverTimestamp()
    }, { merge: true });

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
          btnCargarLegajos.click();
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

// ===== Importación masiva (10 clicks) =====
let unlockClicks = 0;
let importUnlocked = false;

btnUnlockImport?.addEventListener("click", () => {
  unlockClicks++;
  const remaining = Math.max(0, 10 - unlockClicks);

  if (remaining > 0) {
    importHint.textContent = `Faltan ${remaining} clics...`;
    return;
  }

  importUnlocked = true;
  importBox.style.display = "block";
  importHint.textContent = "Importación habilitada.";
  setMsg(msgImport, "", "");
});

btnCancelarImport?.addEventListener("click", () => {
  importUnlocked = false;
  unlockClicks = 0;
  importBox.style.display = "none";
  importHint.textContent = "";
  bulkLegajos.value = "";
  setMsg(msgImport, "", "");
});

function parseLegajosFromBulk(text) {
  // Acepta copiar/pegar desde Excel:
  // - saltos de línea
  // - tabs
  // - múltiples columnas si pegás mal: igual extrae números
  const parts = String(text || "")
    .split(/[,\s;\t\r\n]+/g)
    .map(s => s.trim())
    .filter(Boolean);

  const seen = new Set();
  const ok = [];
  const invalid = [];

  for (const p of parts) {
    const digits = p.replace(/\D/g, "");
    if (!digits || digits.length > 4) { invalid.push(p); continue; }
    const canon = canonicalizeLegajoDigits(digits);
    if (!isValidLegajoCanon(canon)) { invalid.push(p); continue; }
    if (!seen.has(canon)) { seen.add(canon); ok.push(canon); }
  }

  return { ok, invalid };
}

function requireAdminOrThrow() {
  const u = auth.currentUser;
  const isPasswordUser = !!u?.providerData?.some(p => p.providerId === "password");
  if (!u || !isPasswordUser) throw new Error("Solo admin logueado puede importar.");
}

btnImportarLegajos?.addEventListener("click", async () => {
  setMsg(msgImport, "", "");

  try {
    requireAdminOrThrow();
    if (!importUnlocked) return setMsg(msgImport, "Importación bloqueada.", "err");

    const { ok, invalid } = parseLegajosFromBulk(bulkLegajos.value);

    if (!ok.length) return setMsg(msgImport, "No encontré legajos válidos para importar.", "err");

    if (!confirm(`Se importarán/activarán ${ok.length} legajos. ¿Continuar?`)) return;

    btnImportarLegajos.disabled = true;

    let imported = 0;
    let batches = 0;

    for (let i = 0; i < ok.length; i += 450) {
      const slice = ok.slice(i, i + 450);
      const batch = writeBatch(db);

      for (const leg of slice) {
        // si querés NO administrar 0, lo saltás
        if (leg === "0") continue;

        batch.set(doc(db, "legajos_activos", leg), {
          activo: true,
          nombre: "",
          updatedAt: serverTimestamp()
        }, { merge: true });

        imported++;
      }

      await batch.commit();
      batches++;
    }

    await loadLegajosActivos({ force: true });

    setMsg(
      msgImport,
      `OK. Importados/activados: ${imported}. Batches: ${batches}.` +
      (invalid.length ? ` (Inválidos ignorados: ${invalid.slice(0, 10).join(", ")}${invalid.length > 10 ? "..." : ""})` : ""),
      "ok"
    );

    // bloquear de nuevo (solo una vez)
    importUnlocked = false;
    unlockClicks = 0;
    importBox.style.display = "none";
    importHint.textContent = "Importación realizada y bloqueada nuevamente.";
    bulkLegajos.value = "";
  } catch (err) {
    console.error(err);
    setMsg(msgImport, String(err?.message || err), "err");
  } finally {
    btnImportarLegajos.disabled = false;
  }
});

// ===== Init =====
(async function init() {
  try {
    await ensureAnon();
    await loadLegajosActivos({ force: true });
  } catch {}
  refreshPreview();
})();
