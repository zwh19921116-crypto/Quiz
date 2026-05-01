let categorySeed = 1;
let quizSeed = 1;
const DRAFT_STORAGE_KEY = "quiz-maker-draft-v1";
const ROOT_HANDLE_DB_NAME = "quiz-maker-root-handle-db";
const ROOT_HANDLE_STORE_NAME = "handles";
const ROOT_HANDLE_KEY = "root-directory";
const DEFAULT_QUIZ_ROOT = "quizzes";
const ROOT_SOURCE_MODES = {
  AUTO: "auto",
  LOCAL: "local",
  GITHUB: "github"
};
const APP_VERSION = "2.3.1";
let rootDirectoryHandle = null;
let silentSaveTimer = null;

function openRootHandleDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }

    const request = indexedDB.open(ROOT_HANDLE_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ROOT_HANDLE_STORE_NAME)) {
        db.createObjectStore(ROOT_HANDLE_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open handle database."));
  });
}

async function loadSavedRootDirectoryHandle() {
  try {
    const db = await openRootHandleDb();
    if (!db) return null;

    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE_NAME, "readonly");
      const store = tx.objectStore(ROOT_HANDLE_STORE_NAME);
      const request = store.get(ROOT_HANDLE_KEY);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Could not load saved root handle."));
      tx.oncomplete = () => db.close();
      tx.onerror = () => reject(tx.error || new Error("Could not load saved root handle."));
    });
  } catch (error) {
    return null;
  }
}

async function saveRootDirectoryHandle(handle) {
  try {
    const db = await openRootHandleDb();
    if (!db) return false;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE_NAME, "readwrite");
      const store = tx.objectStore(ROOT_HANDLE_STORE_NAME);
      store.put(handle, ROOT_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not save root handle."));
    });
    db.close();
    return true;
  } catch (error) {
    return false;
  }
}

async function clearSavedRootDirectoryHandle() {
  try {
    const db = await openRootHandleDb();
    if (!db) return;

    await new Promise((resolve, reject) => {
      const tx = db.transaction(ROOT_HANDLE_STORE_NAME, "readwrite");
      const store = tx.objectStore(ROOT_HANDLE_STORE_NAME);
      store.delete(ROOT_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Could not clear root handle."));
    });
    db.close();
  } catch (error) {
    // Ignore persistence cleanup failures.
  }
}

async function ensureRootHandlePermission(handle, mode = "readwrite") {
  if (!handle) return false;
  if (typeof handle.queryPermission !== "function") return true;

  try {
    const current = await handle.queryPermission({ mode });
    if (current === "granted") return true;
    if (typeof handle.requestPermission !== "function") return false;
    const next = await handle.requestPermission({ mode });
    return next === "granted";
  } catch (error) {
    return false;
  }
}

async function restoreRootDirectoryHandle({ promptForPermission = false } = {}) {
  if (rootDirectoryHandle) {
    const ok = await ensureRootHandlePermission(rootDirectoryHandle, "readwrite");
    if (ok) return rootDirectoryHandle;
  }

  const savedHandle = await loadSavedRootDirectoryHandle();
  if (!savedHandle) return null;

  const ok = promptForPermission
    ? await ensureRootHandlePermission(savedHandle, "readwrite")
    : (typeof savedHandle.queryPermission === "function"
      ? (await savedHandle.queryPermission({ mode: "readwrite" })) === "granted"
      : true);

  if (!ok) {
    return null;
  }

  rootDirectoryHandle = savedHandle;
  return rootDirectoryHandle;
}

function splitPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((item) => item !== "");
}

const state = {
  categories: [],
  rootFolder: DEFAULT_QUIZ_ROOT,
  rootSourceMode: ROOT_SOURCE_MODES.LOCAL,
  selectedCategoryId: null,
  selectedQuizId: null,
  selectedQuestionIndex: -1,
  draggingQuestionIndex: -1
};

const QUIZ_ORDER_MODES = {
  ORDERED: "ordered",
  RANDOM: "random"
};

function normalizeRootSourceMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === ROOT_SOURCE_MODES.GITHUB) return ROOT_SOURCE_MODES.GITHUB;
  return ROOT_SOURCE_MODES.LOCAL; // default to local (auto is no longer supported)
}

function ensureToastHost() {
  let host = document.getElementById("toastStack");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastStack";
    host.className = "toast-stack";
    document.body.appendChild(host);
  }
  return host;
}

function showToast(message, variant = "info") {
  const host = ensureToastHost();
  const toast = document.createElement("div");
  toast.className = `toast ${variant}`;
  toast.textContent = message;
  host.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add("fade-out");
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, 2200);
}

function isTypingInField(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function reseedCountersFromState() {
  const catTotal = state.categories.length;
  const quizTotal = state.categories.reduce((total, item) => total + (Array.isArray(item.quizzes) ? item.quizzes.length : 0), 0);
  categorySeed = Math.max(1, catTotal + 1);
  quizSeed = Math.max(1, quizTotal + 1);
}

function saveDraft() {
  const payload = {
    categories: state.categories,
    rootFolder: state.rootFolder,
    rootSourceMode: state.rootSourceMode,
    selectedCategoryId: state.selectedCategoryId,
    selectedQuizId: state.selectedQuizId,
    selectedQuestionIndex: state.selectedQuestionIndex
  };

  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    // Ignore storage quota errors and keep app usable.
  }
}

function loadDraft() {
  let raw = "";
  try {
    raw = localStorage.getItem(DRAFT_STORAGE_KEY) || "";
  } catch (error) {
    return false;
  }

  if (!raw) return false;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.categories)) {
      return false;
    }

    state.categories = parsed.categories.map((category) => ({
      id: category.id || `cat-${categorySeed++}`,
      name: category.name || "Category",
      quizzes: Array.isArray(category.quizzes)
        ? category.quizzes.map((quiz) => ({
          id: quiz.id || `quiz-${quizSeed++}`,
          title: quiz.title || "Untitled Quiz",
          description: normalizeQuizDescription(quiz.description),
          settings: normalizeQuizSettings(quiz.settings),
          fileName: quiz.fileName || "",
          sourcePath: quiz.sourcePath || "",
          questions: Array.isArray(quiz.questions) ? quiz.questions.map(normalizeQuestion) : []
        }))
        : []
    }));

    state.rootFolder = String(parsed.rootFolder || DEFAULT_QUIZ_ROOT).trim() || DEFAULT_QUIZ_ROOT;
    state.rootSourceMode = normalizeRootSourceMode(parsed.rootSourceMode || ROOT_SOURCE_MODES.AUTO);

    ensureQuizFileNames();

    state.selectedCategoryId = parsed.selectedCategoryId || null;
    state.selectedQuizId = parsed.selectedQuizId || null;
    state.selectedQuestionIndex = Number.isInteger(parsed.selectedQuestionIndex) ? parsed.selectedQuestionIndex : -1;

    reseedCountersFromState();
    return true;
  } catch (error) {
    return false;
  }
}

function createEmptyQuestion() {
  return {
    question: "",
    resultType: normalizeResultType("multiple-choice"),
    options: ["", "", "", ""],
    correctAnswer: "",
    notesAttachments: [],
    image: "",
    solution: "",
    solutionAttachments: []
  };
}

function createCategory(name) {
  return {
    id: `cat-${categorySeed++}`,
    name,
    quizzes: []
  };
}

function createQuiz(title) {
  const id = `quiz-${quizSeed++}`;
  return {
    id,
    title,
    description: "",
    settings: normalizeQuizSettings(null),
    fileName: buildUniqueQuizFileName(title, id),
    sourcePath: "",
    questions: []
  };
}

function activeCategory() {
  return state.categories.find((item) => item.id === state.selectedCategoryId) || null;
}

function activeQuiz() {
  const category = activeCategory();
  if (!category) return null;
  return category.quizzes.find((item) => item.id === state.selectedQuizId) || null;
}

function activeQuestion() {
  const quiz = activeQuiz();
  if (!quiz || state.selectedQuestionIndex < 0) return null;
  return quiz.questions[state.selectedQuestionIndex] || null;
}

function ensureQuizHasDefaultQuestion(quiz) {
  if (!quiz) return false;
  if (Array.isArray(quiz.questions) && quiz.questions.length > 0) return false;
  quiz.questions = [createEmptyQuestion()];
  return true;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeResultType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (["short-answer", "shortanswer", "short"].includes(normalized)) return "short-answer";
  if (["plot", "graph", "graph-plot", "plot-graph"].includes(normalized)) return "plot";
  if (["true-false", "truefalse", "boolean"].includes(normalized)) return "true-false";
  if (["checkbox", "multi-select", "multiselect"].includes(normalized)) return "checkbox";
  return "multiple-choice";
}

function normalizeQuizDescription(value) {
  return String(value || "").trim();
}

function normalizeQuizQuestionOrder(value) {
  return String(value || "").trim().toLowerCase() === QUIZ_ORDER_MODES.RANDOM
    ? QUIZ_ORDER_MODES.RANDOM
    : QUIZ_ORDER_MODES.ORDERED;
}

function normalizeQuizQuestionLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeQuizSettings(value) {
  const settings = value && typeof value === "object" ? value : {};
  return {
    questionOrder: normalizeQuizQuestionOrder(settings.questionOrder),
    questionLimit: normalizeQuizQuestionLimit(settings.questionLimit)
  };
}

function applyLoadedQuizJsonToQuiz(quiz, quizJson) {
  if (!quiz || !quizJson || typeof quizJson !== "object") return;
  const nextTitle = String(quizJson.title || "").trim();
  if (nextTitle) {
    quiz.title = nextTitle;
  }
  quiz.description = normalizeQuizDescription(quizJson.description);
  quiz.settings = normalizeQuizSettings(quizJson.settings);
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "quiz";
}

function normalizeQuizFileName(value) {
  const raw = String(value || "").trim().replace(/\.json$/i, "");
  return `${slugify(raw)}.json`;
}

function isDataUrl(value) {
  return /^data:/i.test(String(value || "").trim());
}

function deriveAttachmentName(url) {
  const raw = String(url || "").trim();
  if (!raw) return "Attachment";
  if (isDataUrl(raw)) return "Embedded attachment";

  try {
    const parsed = new URL(raw, window.location.href);
    const segments = parsed.pathname.split("/").filter((item) => item !== "");
    return decodeURIComponent(segments[segments.length - 1] || raw);
  } catch (error) {
    const segments = raw.split("/").filter((item) => item !== "");
    return segments[segments.length - 1] || raw;
  }
}

function normalizeSolutionAttachment(item) {
  if (typeof item === "string") {
    const url = item.trim();
    if (!url) return null;
    return {
      name: deriveAttachmentName(url),
      url,
      embedded: isDataUrl(url)
    };
  }

  if (!item || typeof item !== "object") {
    return null;
  }

  const url = String(item.url || item.href || "").trim();
  if (!url) return null;
  return {
    name: String(item.name || "").trim() || deriveAttachmentName(url),
    url,
    embedded: Boolean(item.embedded) || isDataUrl(url)
  };
}

function normalizeSolutionAttachments(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeSolutionAttachment).filter((item) => item && item.url);
}

function parseSolutionAttachmentLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const divider = line.indexOf("|");
      if (divider > 0) {
        return normalizeSolutionAttachment({
          name: line.slice(0, divider).trim(),
          url: line.slice(divider + 1).trim()
        });
      }
      return normalizeSolutionAttachment(line);
    })
    .filter((item) => item && item.url);
}

function serializeManualSolutionAttachments(items) {
  return normalizeSolutionAttachments(items)
    .filter((item) => !item.embedded)
    .map((item) => {
      const defaultName = deriveAttachmentName(item.url);
      return item.name && item.name !== defaultName
        ? `${item.name} | ${item.url}`
        : item.url;
    })
    .join("\n");
}

function buildUniqueQuizFileName(value, excludedQuizId = null) {
  const normalized = normalizeQuizFileName(value);
  const usedNames = new Set();

  state.categories.forEach((category) => {
    (category.quizzes || []).forEach((quiz) => {
      if (!quiz || quiz.id === excludedQuizId) return;
      const fileName = String(quiz.fileName || "").trim().toLowerCase();
      if (fileName) {
        usedNames.add(fileName);
      }
    });
  });

  if (!usedNames.has(normalized.toLowerCase())) {
    return normalized;
  }

  const base = normalized.replace(/\.json$/i, "");
  let counter = 2;
  let candidate = `${base}-${counter}.json`;

  while (usedNames.has(candidate.toLowerCase())) {
    counter += 1;
    candidate = `${base}-${counter}.json`;
  }

  return candidate;
}

function ensureQuizFileNames() {
  const reservedNames = new Set();

  state.categories.forEach((category) => {
    (category.quizzes || []).forEach((quiz) => {
      const normalized = normalizeQuizFileName(quiz.fileName || quiz.title || "quiz");
      const base = normalized.replace(/\.json$/i, "");
      let candidate = normalized;
      let counter = 2;

      while (reservedNames.has(candidate.toLowerCase())) {
        candidate = `${base}-${counter}.json`;
        counter += 1;
      }

      quiz.fileName = candidate;
      reservedNames.add(candidate.toLowerCase());
    });
  });
}

function normalizeRootFolder(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "") || DEFAULT_QUIZ_ROOT;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function extractYoutubeVideoId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();

    if (host === "youtu.be") {
      const idFromPath = parsed.pathname.replace(/^\/+/, "").split("/")[0] || "";
      return /^[a-zA-Z0-9_-]{6,}$/.test(idFromPath) ? idFromPath : "";
    }

    if (host.endsWith("youtube.com")) {
      const idFromSearch = parsed.searchParams.get("v") || "";
      if (/^[a-zA-Z0-9_-]{6,}$/.test(idFromSearch)) {
        return idFromSearch;
      }

      const pathParts = parsed.pathname.split("/").filter((item) => item !== "");
      const marker = pathParts[0] || "";
      if (["embed", "shorts", "live"].includes(marker)) {
        const idFromPath = pathParts[1] || "";
        return /^[a-zA-Z0-9_-]{6,}$/.test(idFromPath) ? idFromPath : "";
      }
    }

    return "";
  } catch (error) {
    return "";
  }
}

function normalizeYoutubeUrl(value) {
  const id = extractYoutubeVideoId(value);
  return id ? `https://www.youtube.com/watch?v=${id}` : "";
}

function extractGoogleDriveFileId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("drive.google.com")) {
      return "";
    }

    const byQuery = parsed.searchParams.get("id") || "";
    if (byQuery) {
      return byQuery;
    }

    const pathParts = parsed.pathname.split("/").filter((item) => item !== "");
    const fileMarkerIndex = pathParts.indexOf("d");
    if (fileMarkerIndex >= 0 && pathParts[fileMarkerIndex + 1]) {
      return pathParts[fileMarkerIndex + 1];
    }

    return "";
  } catch (error) {
    return "";
  }
}

function normalizePdfUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:application\/pdf/i.test(raw)) return raw;

  const driveId = extractGoogleDriveFileId(raw);
  if (driveId) {
    return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(driveId)}`;
  }

  return raw;
}

function isPdfAttachment(value) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  if (/^data:application\/pdf/i.test(raw)) return true;
  if (extractGoogleDriveFileId(raw)) return true;

  try {
    const parsed = new URL(raw, window.location.href);
    return /\.pdf$/i.test(parsed.pathname);
  } catch (error) {
    return /\.pdf($|\?)/i.test(raw);
  }
}

function splitNotesAttachments(items) {
  const result = {
    youtube: "",
    pdf: [],
    other: []
  };

  const values = Array.isArray(items) ? items : [];
  values.forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;

    const youtube = normalizeYoutubeUrl(value);
    if (youtube) {
      if (!result.youtube) {
        result.youtube = youtube;
      }
      return;
    }

    if (isPdfAttachment(value)) {
      result.pdf.push(value);
      return;
    }

    result.other.push(value);
  });

  return result;
}

function buildNotesAttachments(parts) {
  const list = [];
  if (parts.youtube) {
    list.push(parts.youtube);
  }
  if (Array.isArray(parts.pdf) && parts.pdf.length > 0) {
    list.push(...parts.pdf);
  }
  if (Array.isArray(parts.other) && parts.other.length > 0) {
    list.push(...parts.other);
  }
  return list;
}

function mergeUniqueNotesAttachments(items) {
  const seen = new Set();
  const result = [];
  (Array.isArray(items) ? items : []).forEach((item) => {
    const value = String(item || "").trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });
  return result;
}

function parsePdfUrlLines(text) {
  return mergeUniqueNotesAttachments(
    String(text || "")
      .split("\n")
      .map((line) => normalizePdfUrl(line))
      .filter((line) => line !== "")
  );
}

function serializeManualNotesAttachments(items) {
  return splitNotesAttachments(items).other.join("\n");
}

function buildGithubContext(owner, repo, branch, repoPath, rootFolder) {
  const cleanRepoPath = String(repoPath || "").replace(/^\/+|\/+$/g, "");
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}${cleanRepoPath ? `/${cleanRepoPath}` : ""}`;
  return {
    rootFolder,
    fetchBase: rawBase,
    supportsDirectoryScan: false,
    githubRepo: {
      owner,
      repo,
      branch,
      repoPath: cleanRepoPath
    }
  };
}

function inferGithubContextFromPages(rootFolder) {
  const host = String(window.location.hostname || "").toLowerCase();
  if (!host.endsWith(".github.io")) {
    return null;
  }

  const owner = host.replace(/\.github\.io$/i, "");
  const pathSegments = String(window.location.pathname || "")
    .split("/")
    .filter((item) => item !== "");
  const repo = pathSegments[0] || "";
  if (!owner || !repo) {
    return null;
  }

  const repoPath = normalizeRootFolder(rootFolder);
  return buildGithubContext(owner, repo, "main", repoPath, rootFolder);
}

function joinPath(base, relativePath) {
  const cleanBase = String(base || "").replace(/\/+$/g, "");
  const cleanRelative = String(relativePath || "").replace(/^\/+/, "");
  return `${cleanBase}/${cleanRelative}`;
}

function resolveRootFetchContext(rootFolder) {
  const normalized = normalizeRootFolder(rootFolder);
  const fallback = {
    rootFolder: normalized,
    fetchBase: normalized,
    supportsDirectoryScan: !isHttpUrl(normalized),
    githubRepo: null
  };

  if (!isHttpUrl(normalized)) {
    return fallback;
  }

  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter((item) => item !== "");

    if (host === "raw.githubusercontent.com") {
      const rawSegments = parsed.pathname.split("/").filter((item) => item !== "");
      const owner = rawSegments[0] || "";
      const repo = rawSegments[1] || "";
      const branch = rawSegments[2] || "main";
      const repoPath = rawSegments.slice(3).join("/");

      return owner && repo
        ? buildGithubContext(owner, repo, branch, repoPath, normalized)
        : {
          rootFolder: normalized,
          fetchBase: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/g, ""),
          supportsDirectoryScan: false,
          githubRepo: null
        };
    }

    if (host !== "github.com" || segments.length < 2) {
      return {
        rootFolder: normalized,
        fetchBase: normalized,
        supportsDirectoryScan: false,
        githubRepo: null
      };
    }

    const owner = segments[0];
    const repo = segments[1];
    let branch = "main";
    let repoPath = "";

    if (segments[2] === "tree" && segments[3]) {
      branch = segments[3];
      repoPath = segments.slice(4).join("/");
    }

    if (segments[2] === "blob" && segments[3]) {
      branch = segments[3];
      repoPath = segments.slice(4, -1).join("/");
    }

    return buildGithubContext(owner, repo, branch, repoPath, normalized);
  } catch (error) {
    return {
      rootFolder: normalized,
      fetchBase: normalized,
      supportsDirectoryScan: false,
      githubRepo: null
    };
  }
}

function toGitHubApiContentsUrl(githubRepo, path) {
  const encodedPath = String(path || "")
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const base = `https://api.github.com/repos/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}/contents`;
  const target = encodedPath ? `${base}/${encodedPath}` : base;
  return `${target}?ref=${encodeURIComponent(githubRepo.branch)}`;
}

function getGitHubDownloadUrl(entry, githubRepo, path) {
  if (entry && typeof entry.download_url === "string" && entry.download_url.trim() !== "") {
    return entry.download_url;
  }

  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `https://raw.githubusercontent.com/${githubRepo.owner}/${githubRepo.repo}/${githubRepo.branch}/${cleanPath}`;
}

async function readGitHubDirectoryEntries(githubRepo, path) {
  const response = await fetch(toGitHubApiContentsUrl(githubRepo, path), { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not read ${path || githubRepo.repoPath || "/"} from GitHub`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error(`Unexpected GitHub directory payload for ${path || "/"}`);
  }

  return payload;
}

function buildGitHubCdnUrl(githubRepo, filePath) {
  const cleanPath = String(filePath || "").replace(/^\/+/, "");
  return `https://cdn.jsdelivr.net/gh/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}@${encodeURIComponent(githubRepo.branch)}/${cleanPath}`;
}

async function loadLibraryFromGithubFlatIndex(context) {
  if (!context.githubRepo) {
    throw new Error("GitHub repository context is missing.");
  }

  const githubRepo = context.githubRepo;
  const rootPath = String(githubRepo.repoPath || "").replace(/^\/+|\/+$/g, "");
  const rootPrefix = rootPath ? `/${rootPath}/` : "/";
  const indexUrl = `https://data.jsdelivr.com/v1/package/gh/${encodeURIComponent(githubRepo.owner)}/${encodeURIComponent(githubRepo.repo)}@${encodeURIComponent(githubRepo.branch)}/flat`;
  
  console.log("[CDN Fallback] Fetching index from:", indexUrl);
  console.log("[CDN Fallback] Looking for rootPath:", rootPath, "rootPrefix:", rootPrefix);
  
  const indexResponse = await fetch(indexUrl, { cache: "no-store" });
  if (!indexResponse.ok) {
    throw new Error(`Could not read ${rootPath || "repository root"} index from CDN (status ${indexResponse.status})`);
  }

  const indexPayload = await indexResponse.json();
  const files = Array.isArray(indexPayload && indexPayload.files) ? indexPayload.files : [];
  console.log("[CDN Fallback] Total files in repository:", files.length);
  
  const quizFilePaths = files
    .map((entry) => String(entry && entry.name ? entry.name : ""))
    .filter((name) => name.startsWith(rootPrefix))
    .filter((name) => name.toLowerCase().endsWith(".json"))
    .filter((name) => !name.toLowerCase().endsWith("/index.json"));

  console.log("[CDN Fallback] Quiz file paths found:", quizFilePaths.length, quizFilePaths.slice(0, 5));
  
  if (quizFilePaths.length === 0) {
    throw new Error(`No quiz JSON files found in ${rootPath || "repository root"}`);
  }

  const groupedByFolder = new Map();
  quizFilePaths.forEach((fullPath) => {
    const relative = rootPath ? fullPath.slice(rootPrefix.length) : fullPath.replace(/^\/+/, "");
    const folder = relative.split("/")[0] || "";
    if (!folder) {
      return;
    }

    const list = groupedByFolder.get(folder) || [];
    list.push(relative);
    groupedByFolder.set(folder, list);
  });

  if (groupedByFolder.size === 0) {
    throw new Error(`No category folders found in ${rootPath || "repository root"}`);
  }

  const loadedCategories = [];

  for (const [folder, relativePaths] of groupedByFolder.entries()) {
    const category = createCategory(categoryNameFromFolder(folder));

    for (const relativePath of relativePaths) {
      const repoFilePath = rootPath ? `${rootPath}/${relativePath}` : relativePath;
      const quizPath = buildGitHubCdnUrl(githubRepo, repoFilePath);
      const quizResponse = await fetch(quizPath, { cache: "no-store" });
      if (!quizResponse.ok) {
        continue;
      }

      const quizJson = await quizResponse.json();
      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = quizPath;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

async function loadLibraryFromGithubFolders(context) {
  if (!context.githubRepo) {
    throw new Error("GitHub repository context is missing.");
  }

  const githubRepo = context.githubRepo;
  const rootPath = String(githubRepo.repoPath || "").replace(/^\/+|\/+$/g, "");
  const rootEntries = await readGitHubDirectoryEntries(githubRepo, rootPath);
  const categoryFolders = rootEntries
    .filter((entry) => entry && entry.type === "dir")
    .map((entry) => String(entry.name || "").trim())
    .filter((name) => name !== "");

  if (categoryFolders.length === 0) {
    throw new Error(`No category folders found in ${rootPath || "repository root"}`);
  }

  const loadedCategories = [];

  for (const folder of categoryFolders) {
    const category = createCategory(categoryNameFromFolder(folder));
    const folderPath = rootPath ? `${rootPath}/${folder}` : folder;
    let folderEntries = [];

    try {
      folderEntries = await readGitHubDirectoryEntries(githubRepo, folderPath);
    } catch (error) {
      continue;
    }

    const jsonFiles = folderEntries.filter((entry) => {
      if (!entry || entry.type !== "file") return false;
      const name = String(entry.name || "").toLowerCase();
      return name.endsWith(".json") && name !== "index.json";
    });

    for (const fileEntry of jsonFiles) {
      const fileName = String(fileEntry.name || "").trim();
      if (!fileName) {
        continue;
      }

      const relativePath = `${folder}/${fileName}`;
      const repoFilePath = rootPath ? `${rootPath}/${relativePath}` : relativePath;
      const quizPath = getGitHubDownloadUrl(fileEntry, githubRepo, repoFilePath);
      const quizResponse = await fetch(quizPath, { cache: "no-store" });
      if (!quizResponse.ok) {
        continue;
      }

      const quizJson = await quizResponse.json();
      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = quizPath;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

function baseNameFromPath(path) {
  const normalized = String(path || "").trim().replace(/\\/g, "/");
  if (!normalized) return "quiz.json";
  const parts = normalized.split("/").filter((item) => item !== "");
  return parts.length > 0 ? parts[parts.length - 1] : "quiz.json";
}

function quizTitleFromFilePath(path) {
  return baseNameFromPath(path).replace(/\.json$/i, "") || "Untitled Quiz";
}

function getCategoryFolderName(category) {
  const quiz = (category && Array.isArray(category.quizzes))
    ? category.quizzes.find((item) => item && typeof item.sourcePath === "string" && item.sourcePath.trim() !== "")
    : null;

  if (!quiz || !quiz.sourcePath) {
    return slugify(category && category.name ? category.name : "category");
  }

  const normalizedRoot = `${normalizeRootFolder(state.rootFolder)}/`;
  const normalizedSource = String(quiz.sourcePath).replace(/\\/g, "/");
  const relative = normalizedSource.startsWith(normalizedRoot)
    ? normalizedSource.slice(normalizedRoot.length)
    : normalizedSource;
  const folder = relative.split("/")[0] || "";
  return folder || slugify(category && category.name ? category.name : "category");
}

function supportsFolderDeletion() {
  return typeof window.showDirectoryPicker === "function";
}

async function getRootDirectoryHandle(options = {}) {
  const { allowPrompt = true, promptForPermission = true } = options;

  if (rootDirectoryHandle) {
    const ok = await ensureRootHandlePermission(rootDirectoryHandle, "readwrite");
    if (ok) {
      return rootDirectoryHandle;
    }
    rootDirectoryHandle = null;
  }

  const restoredHandle = await restoreRootDirectoryHandle({ promptForPermission });
  if (restoredHandle) {
    return restoredHandle;
  }

  if (!allowPrompt) {
    return null;
  }

  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  rootDirectoryHandle = handle;
  await saveRootDirectoryHandle(handle);
  return handle;
}

async function getConfiguredRootHandle(options = {}) {
  const { create = false, allowPrompt = true, promptForPermission = true } = options;
  const rootHandle = await getRootDirectoryHandle({ allowPrompt, promptForPermission });
  if (!rootHandle) {
    return null;
  }
  const rootSegments = splitPath(normalizeRootFolder(state.rootFolder));
  if (rootSegments.length === 0) {
    return rootHandle;
  }

  // If the user already selected the effective quiz root folder (for example picked
  // "quizzes" while rootFolder is also "quizzes"), use it directly to avoid nesting.
  const lastRootSegment = rootSegments[rootSegments.length - 1];
  if (normalizeRootSourceMode(state.rootSourceMode) === ROOT_SOURCE_MODES.LOCAL
    && String(rootHandle.name || "").trim().toLowerCase() === String(lastRootSegment || "").trim().toLowerCase()) {
    return rootHandle;
  }

  let cursor = rootHandle;
  try {
    for (const segment of rootSegments) {
      cursor = await cursor.getDirectoryHandle(segment, { create: false });
    }
    return cursor;
  } catch (error) {
    if (!create) {
      return rootHandle;
    }
  }

  cursor = rootHandle;
  for (const segment of rootSegments) {
    cursor = await cursor.getDirectoryHandle(segment, { create: true });
  }
  return cursor;
}

async function connectRootDirectoryHandle() {
  rootDirectoryHandle = null;
  try {
    const selected = await getRootDirectoryHandle();
    await saveRootDirectoryHandle(selected);
    const target = await getConfiguredRootHandle({ create: false });
    const modeText = selected.name === target.name
      ? `using ${selected.name}`
      : `using ${selected.name}/${normalizeRootFolder(state.rootFolder)}`;
    showToast(`Connected root folder (${modeText})`, "success");
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Root folder selection canceled.", "info");
      return false;
    }

    await clearSavedRootDirectoryHandle();
    showToast("Could not connect root folder.", "warning");
    return false;
  }
}

async function pathExistsInHandle(rootHandle, relativePath) {
  const parts = String(relativePath || "").split("/").filter((item) => item !== "");
  if (parts.length === 0) {
    return false;
  }

  let directoryHandle = rootHandle;
  const fileName = parts.pop();

  try {
    for (const segment of parts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
    }

    await directoryHandle.getFileHandle(fileName, { create: false });
    return true;
  } catch (error) {
    return false;
  }
}

async function resolveWritableQuizRelativePath(rootHandle, quiz, category) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  const rawSourcePath = String(quiz.sourcePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const fallbackPath = `${slugify(category.name || "category")}/${normalizeQuizFileName(quiz.fileName || quiz.title || "quiz")}`;
  const candidates = [];

  if (rawSourcePath) {
    const prefix = `${rootFolder}/`;
    if (rawSourcePath.startsWith(prefix)) {
      candidates.push(rawSourcePath.slice(prefix.length));
    } else {
      candidates.push(rawSourcePath);
    }
  }

  candidates.push(fallbackPath);

  const uniqueCandidates = Array.from(new Set(candidates.filter((item) => item && item.includes("/"))));
  for (const candidate of uniqueCandidates) {
    if (await pathExistsInHandle(rootHandle, candidate)) {
      return candidate;
    }
  }

  return rawSourcePath.startsWith(`${rootFolder}/`) ? rawSourcePath.slice(rootFolder.length + 1) : (rawSourcePath || fallbackPath);
}

async function deleteCategoryFolderFromDisk(category) {
  if (!supportsFolderDeletion()) {
    showToast("Category removed in app. Browser cannot auto-delete local folders here.", "warning");
    return;
  }

  const folderName = getCategoryFolderName(category);
  if (!folderName) {
    return;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: false });
    await configuredRoot.removeEntry(folderName, { recursive: true });
    showToast(`Folder deleted: ${folderName}`, "success");
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Category removed. Folder delete canceled.", "info");
      return;
    }

    if (error && error.name === "NotFoundError") {
      showToast(`Category removed. Folder not found: ${folderName}`, "info");
      return;
    }

    showToast("Category removed. Could not delete folder on disk.", "warning");
  }
}

async function createCategoryFolderOnDisk(category) {
  if (!supportsFolderDeletion()) {
    showToast("Category created in app. Browser cannot auto-create local folders here.", "warning");
    return;
  }

  const folderName = getCategoryFolderName(category);
  if (!folderName) {
    return;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: true });
    await configuredRoot.getDirectoryHandle(folderName, { create: true });
    showToast(`Folder ready: ${folderName}`, "success");
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Category created. Folder create canceled.", "info");
      return;
    }

    showToast("Category created. Could not create folder on disk.", "warning");
  }
}

async function createStarterQuizFileOnDisk(category, quiz) {
  if (!supportsFolderDeletion()) {
    return;
  }

  if (!category || !quiz) {
    return;
  }

  const folderName = getCategoryFolderName(category);
  const fileName = normalizeQuizFileName(quiz.fileName || quiz.title || "new-quiz");
  const sourcePath = `${normalizeRootFolder(state.rootFolder)}/${folderName}/${fileName}`;

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: true });
    const categoryHandle = await configuredRoot.getDirectoryHandle(folderName, { create: true });
    const fileHandle = await categoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();

    const starterPayload = {
      id: slugify(quiz.title || "new-quiz"),
      title: quiz.title || "New Quiz",
      description: normalizeQuizDescription(quiz.description),
      settings: normalizeQuizSettings(quiz.settings),
      category: category.name || "Category",
      questions: Array.isArray(quiz.questions) && quiz.questions.length > 0
        ? quiz.questions.map((item) => ({
          question: item.question || "",
          resultType: item.resultType || "multiple-choice",
          options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
          correctAnswer: item.correctAnswer || "",
          notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
          image: item.image || "",
          solution: item.solution || "",
          solutionAttachments: Array.isArray(item.solutionAttachments) ? item.solutionAttachments : []
        }))
        : [createEmptyQuestion()]
    };

    await writable.write(`${JSON.stringify(starterPayload, null, 2)}\n`);
    await writable.close();

    quiz.fileName = fileName;
    quiz.sourcePath = sourcePath;
    showToast(`Starter quiz file created: ${folderName}/${fileName}`, "success");
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Category created. Starter quiz file create canceled.", "info");
      return;
    }

    showToast("Category created. Could not create starter quiz file.", "warning");
  }
}

function categoryNameFromFolder(folderName) {
  return String(folderName || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "Category";
}

function extractDirectoryEntries(html, responseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html || ""), "text/html");
  const baseUrl = new URL(responseUrl, window.location.href);
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  const folders = new Set();
  const jsonFiles = new Set();

  Array.from(doc.querySelectorAll("a[href]")).forEach((link) => {
    const href = String(link.getAttribute("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("?")) {
      return;
    }

    let resolved;
    try {
      resolved = new URL(href, baseUrl.toString());
    } catch (error) {
      return;
    }

    let relativePath = decodeURIComponent(resolved.pathname);
    if (relativePath.startsWith(basePath)) {
      relativePath = relativePath.slice(basePath.length);
    }

    relativePath = relativePath.replace(/^\/+/, "");
    if (!relativePath || relativePath.startsWith("..")) {
      return;
    }

    if (relativePath.endsWith("/")) {
      const folder = relativePath.replace(/\/+$/, "").split("/")[0];
      if (folder) {
        folders.add(folder);
      }
      return;
    }

    if (relativePath.toLowerCase().endsWith(".json")) {
      jsonFiles.add(relativePath);
    }
  });

  return {
    folders: Array.from(folders),
    jsonFiles: Array.from(jsonFiles)
  };
}

async function readDirectoryEntries(folderPath) {
  const normalizedFolder = normalizeRootFolder(folderPath);
  const response = await fetch(`${normalizedFolder}/`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Could not read ${normalizedFolder}/`);
  }

  const html = await response.text();
  return extractDirectoryEntries(html, response.url);
}

async function readJsonFromFileHandle(fileHandle) {
  const file = await fileHandle.getFile();
  const text = await file.text();
  return JSON.parse(text);
}

async function getFileHandleByRelativePath(rootHandle, relativePath) {
  const parts = String(relativePath || "").replace(/\\/g, "/").split("/").filter((item) => item !== "");
  if (parts.length === 0) {
    throw new Error("Invalid relative file path.");
  }

  const fileName = parts.pop();
  let directoryHandle = rootHandle;
  for (const segment of parts) {
    directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
  }

  return directoryHandle.getFileHandle(fileName, { create: false });
}

async function listDirectoryEntriesFromHandle(directoryHandle) {
  const folders = [];
  const files = [];

  // The picker-backed handle supports async iteration across child entries.
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "directory") {
      folders.push(name);
      continue;
    }

    if (handle.kind === "file") {
      files.push(name);
    }
  }

  return { folders, files };
}

async function loadLibraryFromHandleCategoryFolders(rootHandle, rootFolder) {
  const rootEntries = await listDirectoryEntriesFromHandle(rootHandle);
  if (!Array.isArray(rootEntries.folders) || rootEntries.folders.length === 0) {
    throw new Error(`No category folders found in ${rootFolder}/`);
  }

  const loadedCategories = [];

  for (const folder of rootEntries.folders) {
    const category = createCategory(categoryNameFromFolder(folder));
    let categoryHandle;

    try {
      categoryHandle = await rootHandle.getDirectoryHandle(folder, { create: false });
    } catch (error) {
      loadedCategories.push(category);
      continue;
    }

    const categoryEntries = await listDirectoryEntriesFromHandle(categoryHandle);
    const jsonFiles = (categoryEntries.files || []).filter((name) => String(name || "").toLowerCase().endsWith(".json"));

    for (const fileName of jsonFiles) {
      let quizJson;
      try {
        const fileHandle = await categoryHandle.getFileHandle(fileName, { create: false });
        quizJson = await readJsonFromFileHandle(fileHandle);
      } catch (error) {
        continue;
      }

      const relativePath = `${folder}/${fileName}`;
      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = `${rootFolder}/${relativePath}`;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

async function loadLibraryFromHandleManifest(rootHandle, rootFolder) {
  let indexHandle;
  try {
    indexHandle = await rootHandle.getFileHandle("index.json", { create: false });
  } catch (error) {
    throw new Error(`Could not read ${rootFolder}/index.json`);
  }

  const manifest = await readJsonFromFileHandle(indexHandle);
  if (!manifest || !Array.isArray(manifest.categories)) {
    throw new Error(`Invalid ${rootFolder}/index.json`);
  }

  const loadedCategories = [];

  for (const categoryInfo of manifest.categories) {
    const category = createCategory(categoryInfo.name || "Category");
    const quizEntries = Array.isArray(categoryInfo.quizzes) ? categoryInfo.quizzes : [];

    for (const entry of quizEntries) {
      const relativePath = String(entry.file || "").trim().replace(/^\/+/, "");
      if (!relativePath) {
        continue;
      }

      let quizJson;
      try {
        const fileHandle = await getFileHandleByRelativePath(rootHandle, relativePath);
        quizJson = await readJsonFromFileHandle(fileHandle);
      } catch (error) {
        continue;
      }

      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = `${rootFolder}/${relativePath}`;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

async function loadLibraryFromCategoryFolders(rootFolder) {
  const rootEntries = await readDirectoryEntries(rootFolder);
  if (!Array.isArray(rootEntries.folders) || rootEntries.folders.length === 0) {
    throw new Error(`No category folders found in ${rootFolder}/`);
  }

  const loadedCategories = [];

  for (const folder of rootEntries.folders) {
    const category = createCategory(categoryNameFromFolder(folder));
    const folderEntries = await readDirectoryEntries(`${rootFolder}/${folder}`);
    const jsonFiles = (folderEntries.jsonFiles || []).filter((entry) => entry.toLowerCase().endsWith(".json"));

    for (const fileEntry of jsonFiles) {
      const relativeFilePath = fileEntry.includes("/") ? fileEntry : `${folder}/${fileEntry}`;
      const quizResponse = await fetch(`${rootFolder}/${relativeFilePath}`, { cache: "no-store" });
      if (!quizResponse.ok) {
        continue;
      }

      const quizJson = await quizResponse.json();
      const quiz = createQuiz(quizTitleFromFilePath(relativeFilePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativeFilePath));
      quiz.sourcePath = `${rootFolder}/${relativeFilePath}`;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    loadedCategories.push(category);
  }

  return loadedCategories;
}

function pickInitialSelection(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    return {
      categoryId: null,
      quizId: null,
      questionIndex: -1
    };
  }

  const firstCategoryWithQuiz = categories.find((category) => Array.isArray(category.quizzes) && category.quizzes.length > 0);
  const selectedCategory = firstCategoryWithQuiz || categories[0];
  const selectedQuiz = selectedCategory && Array.isArray(selectedCategory.quizzes)
    ? selectedCategory.quizzes[0] || null
    : null;

  return {
    categoryId: selectedCategory ? selectedCategory.id : null,
    quizId: selectedQuiz ? selectedQuiz.id : null,
    questionIndex: selectedQuiz && Array.isArray(selectedQuiz.questions) && selectedQuiz.questions.length > 0 ? 0 : -1
  };
}

async function loadLibraryFromManifest(context) {
  const indexPath = joinPath(context.fetchBase, "index.json");
  const response = await fetch(indexPath, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Could not read ${indexPath}`);
  }

  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.categories)) {
    throw new Error(`Invalid ${indexPath}`);
  }

  const loadedCategories = [];

  for (const categoryInfo of manifest.categories) {
    const category = createCategory(categoryInfo.name || "Category");
    const quizEntries = Array.isArray(categoryInfo.quizzes) ? categoryInfo.quizzes : [];

    for (const entry of quizEntries) {
      const relativePath = String(entry.file || "").trim().replace(/^\/+/, "");
      if (!relativePath) {
        continue;
      }

      const quizPath = joinPath(context.fetchBase, relativePath);
      const quizResponse = await fetch(quizPath, { cache: "no-store" });
      if (!quizResponse.ok) {
        continue;
      }

      const quizJson = await quizResponse.json();
      const quiz = createQuiz(quizTitleFromFilePath(relativePath));
      quiz.fileName = normalizeQuizFileName(baseNameFromPath(relativePath));
      quiz.sourcePath = quizPath;
      applyLoadedQuizJsonToQuiz(quiz, quizJson);
      quiz.questions = Array.isArray(quizJson.questions) ? quizJson.questions.map(normalizeQuestion) : [];
      category.quizzes.push(quiz);
    }

    if (category.quizzes.length > 0) {
      loadedCategories.push(category);
    }
  }

  if (loadedCategories.length === 0) {
    throw new Error(`No quizzes found in ${indexPath}`);
  }

  return loadedCategories;
}

function setRootStatus(message) {
  const status = document.getElementById("rootStatusText");
  if (!status) return;
  status.textContent = message;
}

function updateLocalFolderRowVisibility() {
  const row = document.getElementById("localFolderRow");
  if (!row) return;
  const isLocalMode = normalizeRootSourceMode(state.rootSourceMode) === ROOT_SOURCE_MODES.LOCAL;
  row.style.display = isLocalMode ? "flex" : "none";

  if (!isLocalMode) {
    const field = document.getElementById("localFolderPath");
    if (field) {
      field.value = "";
    }
  }
}

function resolveLocalFolderDisplayPath(handleOrName) {
  if (!handleOrName) return "";

  if (typeof handleOrName === "string") {
    return handleOrName;
  }

  // Some runtimes expose full path metadata (non-standard). Use it when available.
  if (typeof handleOrName.path === "string" && handleOrName.path.trim() !== "") {
    return handleOrName.path;
  }

  if (typeof handleOrName.fullPath === "string" && handleOrName.fullPath.trim() !== "") {
    return handleOrName.fullPath;
  }

  if (typeof handleOrName.name === "string" && handleOrName.name.trim() !== "") {
    return handleOrName.name;
  }

  return "";
}

function setLocalFolderPath(handleOrName) {
  const field = document.getElementById("localFolderPath");
  if (!field) return;

  const displayPath = resolveLocalFolderDisplayPath(handleOrName);
  const isDirectoryHandle = typeof handleOrName === "object" && handleOrName !== null;
  const hasFullPathMetadata = Boolean(
    isDirectoryHandle
    && ((typeof handleOrName.path === "string" && handleOrName.path.trim() !== "")
      || (typeof handleOrName.fullPath === "string" && handleOrName.fullPath.trim() !== ""))
  );

  if (isDirectoryHandle && !hasFullPathMetadata && displayPath) {
    field.value = `${displayPath} (full path hidden by browser security)`;
    field.title = "Full local paths are not exposed to regular web pages.";
    return;
  }

  field.value = displayPath;
  field.title = displayPath || "";
}

async function loadLibraryFromRoot({ allowPrompt = true } = {}) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  let context = resolveRootFetchContext(rootFolder);
  const rootSourceMode = normalizeRootSourceMode(state.rootSourceMode);

  console.log("[loadLibraryFromRoot] rootFolder:", rootFolder, "rootSourceMode:", rootSourceMode);
  console.log("[loadLibraryFromRoot] Initial context:", { githubRepo: context.githubRepo ? "present" : "null", supportsDirectoryScan: context.supportsDirectoryScan });

  let loadedCategories = [];
  let sourceMode = "manifest";

  if (rootSourceMode === ROOT_SOURCE_MODES.GITHUB) {
    console.log("[loadLibraryFromRoot] Entering GITHUB mode block");
    if (!context.githubRepo) {
      const inferred = inferGithubContextFromPages(rootFolder);
      if (inferred) {
        context = inferred;
      }
    }

    if (!context.githubRepo) {
      throw new Error("GitHub mode requires a GitHub URL, or running on a github.io site with a repo root like quizzes.");
    }

    try {
      loadedCategories = await loadLibraryFromGithubFolders(context);
      sourceMode = "github-folder-scan";
    } catch (githubScanError) {
      console.log("[loadLibraryFromRoot] GitHub API scan failed, trying CDN fallback: ", githubScanError.message);
      try {
        loadedCategories = await loadLibraryFromGithubFlatIndex(context);
        sourceMode = "github-flat-scan";
      } catch (cdnScanError) {
        console.error("[loadLibraryFromRoot] Both GitHub API and CDN fallback failed");
        throw new Error(`Could not read category folders from GitHub root: ${state.rootFolder}`);
      }
    }
  } else if (rootSourceMode === ROOT_SOURCE_MODES.LOCAL) {
    if (isHttpUrl(rootFolder)) {
      throw new Error("Local mode expects a local path like quizzes, not an http URL.");
    }

    // Primary: File System Access API
    if (supportsFolderDeletion()) {
      // On explicit refresh, always show picker so user can re-select.
      // On silent load (allowPrompt=false), try saved handle only.
      if (!allowPrompt) {
        try {
          const savedRoot = await getConfiguredRootHandle({ create: false, allowPrompt: false });
          if (savedRoot) {
            loadedCategories = await loadLibraryFromHandleCategoryFolders(savedRoot, rootFolder);
            sourceMode = "handle-folder-scan";
            setLocalFolderPath(savedRoot);
          }
        } catch (savedHandleError) {
          console.warn("[LOCAL] Saved handle failed:", savedHandleError.message);
        }
      }

      // Show picker when user explicitly clicks Refresh, or if silent load found nothing
      if (loadedCategories.length === 0 && allowPrompt) {
        let pickerAborted = false;
        try {
          const freshHandle = await window.showDirectoryPicker({ mode: "readwrite" });
          rootDirectoryHandle = freshHandle;
          await saveRootDirectoryHandle(freshHandle);
          // Scan the selected folder directly — user picked exactly what they want
          loadedCategories = await loadLibraryFromHandleCategoryFolders(freshHandle, freshHandle.name);
          sourceMode = "handle-folder-scan";
          setLocalFolderPath(freshHandle);
        } catch (pickerError) {
          if (pickerError.name === "AbortError") {
            pickerAborted = true;
          } else {
            console.error("[LOCAL] Folder scan after picker failed:", pickerError.message);
            throw new Error(`Could not read category folders from selected folder: ${pickerError.message}`);
          }
        }
        if (pickerAborted) {
          throw new Error("No folder selected. Please click Refresh and select your quiz root folder.");
        }
      }
    }

    // Fallback: manifest (index.json)
    if (loadedCategories.length === 0) {
      try {
        const indexPath = `${rootFolder}/index.json`;
        const response = await fetch(indexPath, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Could not read ${indexPath}`);
        }
        const manifest = await response.json();
        if (!manifest || !Array.isArray(manifest.categories)) {
          throw new Error(`Invalid ${rootFolder}/index.json`);
        }
        loadedCategories = await loadLibraryFromManifest({ fetchBase: rootFolder });
        sourceMode = "manifest";
      } catch (manifestError) {
        throw new Error(`Could not read category folders from local root: ${state.rootFolder}. Select a folder or ensure index.json exists.`);
      }
    }
  } else {
    throw new Error("Unknown root source mode. Please select Local or GitHub.");
  }

  state.categories = loadedCategories;
  state.rootFolder = rootFolder;
  const initialSelection = pickInitialSelection(loadedCategories);
  state.selectedCategoryId = initialSelection.categoryId;
  state.selectedQuizId = initialSelection.quizId;
  state.selectedQuestionIndex = initialSelection.questionIndex;
  ensureQuizFileNames();
  return sourceMode;
}

async function refreshLibraryFromRoot(notify = true, allowPrompt = true) {
  const rootInput = document.getElementById("quizRootFolder");
  const rootSourceModeInput = document.getElementById("rootSourceMode");
  if (rootInput) {
    state.rootFolder = normalizeRootFolder(rootInput.value);
    rootInput.value = state.rootFolder;
  }
  if (rootSourceModeInput) {
    state.rootSourceMode = normalizeRootSourceMode(rootSourceModeInput.value);
    rootSourceModeInput.value = state.rootSourceMode;
  }

  try {
    const sourceMode = await loadLibraryFromRoot({ allowPrompt });
    renderAll();
    const sourceText = sourceMode === "github-folder-scan"
      ? `Source: auto-detected from GitHub category folders in ${state.rootFolder}`
      : sourceMode === "github-flat-scan"
        ? `Source: auto-detected from GitHub file index in ${state.rootFolder}`
      : sourceMode === "folder-scan"
        ? `Source: auto-detected from category folders in ${state.rootFolder}/`
        : sourceMode === "handle-folder-scan"
          ? `Source: auto-detected from local selected folder in ${state.rootFolder}/`
          : sourceMode === "handle-manifest"
            ? `Source: auto-detected from local selected folder manifest ${state.rootFolder}/index.json`
        : `Source: auto-detected from ${state.rootFolder}/index.json`;
    setRootStatus(sourceText);
    if (notify) {
      showToast("Root library detected and loaded.", "success");
    }
    return true;
  } catch (error) {
    setRootStatus(`Source: could not load categories from ${state.rootFolder} (folder scan and index.json fallback failed)`);
    if (notify) {
      showToast(String(error.message || "Could not load root library."), "warning");
    }
    return false;
  }
}

function getSelectedQuizFileName() {
  const selectedQuiz = activeQuiz();
  if (!selectedQuiz) {
    return "quiz.json";
  }

  return selectedQuiz.fileName || normalizeQuizFileName(selectedQuiz.title);
}

function getQuestionValidationIssues(question) {
  const issues = [];
  const resultType = question.resultType || "multiple-choice";
  const isCartesianPlotQuestion = Boolean(
    question
    && question.interactiveApp
    && question.interactiveApp.type === "cartesian-plane-plot"
  );
  const optionValues = Array.isArray(question.options) ? question.options.map((item) => String(item || "").trim()) : [];
  const choiceOptions = optionValues.filter((item) => item !== "");
  const answerValue = String(question.correctAnswer || "").trim();

  if (!String(question.question || "").trim()) {
    issues.push("Question text is required.");
  }

  if (!isCartesianPlotQuestion && ["multiple-choice", "checkbox", "true-false"].includes(resultType) && choiceOptions.length < 2) {
    issues.push("At least two options are required for this result type.");
  }

  if (isCartesianPlotQuestion) {
    const answerPoints = Array.isArray(question.interactiveApp && question.interactiveApp.config && question.interactiveApp.config.points)
      ? question.interactiveApp.config.points
      : [];
    if (answerPoints.length === 0) {
      issues.push("Cartesian Plane - Plot requires at least one answer point.");
    }
  } else if (!answerValue) {
    issues.push("Correct answer is required.");
  } else if (["multiple-choice", "true-false"].includes(resultType)) {
    const matchesChoice = choiceOptions.some((item) => normalizeText(item) === normalizeText(answerValue));
    if (!matchesChoice) {
      issues.push("Correct answer must match one option exactly.");
    }
  } else if (resultType === "checkbox") {
    const answers = answerValue.split(",").map((item) => item.trim()).filter((item) => item !== "");
    const invalid = answers.some((item) => !choiceOptions.some((option) => normalizeText(option) === normalizeText(item)));
    if (answers.length === 0 || invalid) {
      issues.push("Checkbox correct answer must be one or more comma-separated options.");
    }
  }

  return issues;
}

function renderValidationBox(question) {
  const box = document.getElementById("questionValidationBox");
  if (!question) {
    box.innerHTML = "<p class='helper-text'>Select a question to see validation.</p>";
    return;
  }

  const issues = getQuestionValidationIssues(question);
  if (issues.length === 0) {
    box.innerHTML = "<p class='validation-ok'>Ready to publish.</p>";
    return;
  }

  box.innerHTML = `
    <p class="validation-title">Needs attention:</p>
    <ul class="validation-list">
      ${issues.map((item) => `<li>${item}</li>`).join("")}
    </ul>
  `;
}

function ensureSelection() {
  if (state.categories.length === 0) {
    state.selectedCategoryId = null;
    state.selectedQuizId = null;
    state.selectedQuestionIndex = -1;
    return;
  }

  if (!state.categories.some((item) => item.id === state.selectedCategoryId)) {
    state.selectedCategoryId = state.categories[0].id;
  }

  const category = activeCategory();
  if (!category) return;

  if (!category.quizzes.some((item) => item.id === state.selectedQuizId)) {
    state.selectedQuizId = category.quizzes[0] ? category.quizzes[0].id : null;
  }

  const quiz = activeQuiz();
  if (!quiz) {
    state.selectedQuestionIndex = -1;
    return;
  }

  const createdDefaultQuestion = ensureQuizHasDefaultQuestion(quiz);
  if (createdDefaultQuestion && state.selectedQuestionIndex < 0) {
    state.selectedQuestionIndex = 0;
  }

  if (state.selectedQuestionIndex >= quiz.questions.length) {
    state.selectedQuestionIndex = quiz.questions.length - 1;
  }

  if (quiz.questions.length === 0) {
    state.selectedQuestionIndex = -1;
  }
}

function renderCategoryList() {
  const host = document.getElementById("categoryList");
  host.innerHTML = "";

  if (state.categories.length === 0) {
    host.innerHTML = "<p class='helper-text'>No categories yet.</p>";
    return;
  }

  const searchInput = document.getElementById("categorySearch");
  const term = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const filtered = term
    ? state.categories.filter((category) => category.name.toLowerCase().includes(term))
    : state.categories;

  if (filtered.length === 0) {
    host.innerHTML = "<p class='helper-text'>No categories match.</p>";
    return;
  }

  filtered.forEach((category) => {
    const row = document.createElement("div");
    row.className = `list-item ${category.id === state.selectedCategoryId ? "active" : ""}`;
    row.innerHTML = `
      <button class="list-main" data-id="${category.id}" type="button">${category.name}</button>
      <button class="icon-btn danger" data-action="delete" data-id="${category.id}" type="button">x</button>
    `;
    host.appendChild(row);
  });
}

function renderQuizList() {
  const host = document.getElementById("quizList");
  host.innerHTML = "";

  const category = activeCategory();
  if (!category) {
    host.innerHTML = "<p class='helper-text'>Select a category first.</p>";
    return;
  }

  if (category.quizzes.length === 0) {
    host.innerHTML = "<p class='helper-text'>No quizzes yet.</p>";
    return;
  }

  const searchInput = document.getElementById("quizSearch");
  const term = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const filtered = term
    ? category.quizzes.filter((quiz) => quiz.title.toLowerCase().includes(term))
    : category.quizzes;

  if (filtered.length === 0) {
    host.innerHTML = "<p class='helper-text'>No quizzes match.</p>";
    return;
  }

  filtered.forEach((quiz) => {
    const row = document.createElement("div");
    row.className = `list-item ${quiz.id === state.selectedQuizId ? "active" : ""}`;
    row.innerHTML = `
      <button class="list-main" data-id="${quiz.id}" type="button">${quiz.title}</button>
      <button class="icon-btn secondary" data-action="settings" data-id="${quiz.id}" type="button">Settings</button>
      <button class="icon-btn secondary" data-action="replicate" data-id="${quiz.id}" type="button">Replicate</button>
      <button class="icon-btn secondary" data-action="auto" data-id="${quiz.id}" type="button">Auto</button>
      <button class="icon-btn danger" data-action="delete" data-id="${quiz.id}" type="button">x</button>
    `;
    host.appendChild(row);
  });
}

function buildQuizViewerUrl(quizId) {
  const category = activeCategory();
  if (!category) return null;
  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) return null;

  const fileName = quiz.sourcePath || quiz.fileName || normalizeQuizFileName(quiz.title);
  const viewerUrl = new URL("viewer.html", window.location.href);
  viewerUrl.searchParams.set("file", fileName);

  return viewerUrl;
}

function buildQuizIframeCode(quizId) {
  const viewerUrl = buildQuizViewerUrl(quizId);
  if (!viewerUrl) return "";

  return `<iframe src="${viewerUrl.toString()}" width="100%" height="640" style="border:0;" loading="lazy" allowfullscreen></iframe>`;
}

function buildQuizLinkCode(quizId) {
  const viewerUrl = buildQuizViewerUrl(quizId);
  return viewerUrl ? viewerUrl.toString() : "";
}

function getSelectedEmbedFormat() {
  const select = document.getElementById("embedFormatSelect");
  if (!(select instanceof HTMLSelectElement)) {
    return "iframe";
  }

  return select.value === "link" ? "link" : "iframe";
}

function buildEmbedCodeForQuiz(quizId, format) {
  return format === "link" ? buildQuizLinkCode(quizId) : buildQuizIframeCode(quizId);
}

function updateEmbedOutputForActiveQuiz() {
  const output = document.getElementById("iframeCodeOutput");
  if (!(output instanceof HTMLTextAreaElement)) return;

  const quiz = activeQuiz();
  if (!quiz) {
    output.value = "";
    return;
  }

  const format = getSelectedEmbedFormat();
  output.value = buildEmbedCodeForQuiz(quiz.id, format);
}

async function generateAndCopyEmbedCode(quizId) {
  const format = getSelectedEmbedFormat();

  const code = buildEmbedCodeForQuiz(quizId, format);
  if (!code) {
    showToast("Could not generate code.", "error");
    return;
  }

  const output = document.getElementById("iframeCodeOutput");
  output.value = code;

  try {
    await navigator.clipboard.writeText(code);
    showToast(`${format === "link" ? "Link" : "Iframe"} copied.`, "success");
  } catch (error) {
    showToast("Could not copy code.", "error");
  }
}

function renderQuestionsList() {
  const host = document.getElementById("questionsList");
  host.innerHTML = "";

  const quiz = activeQuiz();
  if (!quiz) {
    host.innerHTML = "<p class='helper-text'>Select a quiz first.</p>";
    return;
  }

  if (quiz.questions.length === 0) {
    host.innerHTML = "<p class='helper-text'>No questions yet.</p>";
    return;
  }

  const searchInput = document.getElementById("questionSearch");
  const term = searchInput ? searchInput.value.trim().toLowerCase() : "";

  quiz.questions.forEach((item, index) => {
    const title = item.question || `Untitled Question ${index + 1}`;
    if (term && !title.toLowerCase().includes(term)) {
      return;
    }

    const issues = getQuestionValidationIssues(item);
    const badgeClass = issues.length === 0 ? "status-chip ok" : "status-chip warn";
    const badgeText = issues.length === 0 ? "Ready" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`;
    const row = document.createElement("div");
    row.className = `list-item ${index === state.selectedQuestionIndex ? "active" : ""}`;
    row.draggable = true;
    row.dataset.dragIndex = String(index);
    row.innerHTML = `
      <button class="list-main" data-index="${index}" type="button">Q${index + 1}: ${title}</button>
      <span class="${badgeClass}">${badgeText}</span>
      <button class="icon-btn danger" data-action="delete" data-index="${index}" type="button">x</button>
    `;
    host.appendChild(row);
  });

  if (host.children.length === 0) {
    host.innerHTML = "<p class='helper-text'>No questions match.</p>";
  }
}

function toggleOptionsBlock(question) {
  const isChoiceType = question && ["multiple-choice", "checkbox"].includes(question.resultType);
  document.getElementById("optionsBlock").style.display = isChoiceType ? "block" : "none";
}

function ensureTrueFalseOptions(question) {
  if (!question) return;
  if ((question.resultType || "multiple-choice") !== "true-false") return;
  question.options = ["True", "False", "", ""];
}

function getChoiceOptions(question) {
  if (!question) return [];
  const options = Array.isArray(question.options) ? question.options : [];
  return options.map((item) => String(item || "").trim()).filter((item) => item !== "");
}

function ensureDefaultCorrectAnswer(question) {
  if (!question) return;

  const resultType = question.resultType || "multiple-choice";
  if (resultType === "true-false") {
    ensureTrueFalseOptions(question);
  }

  if (!["multiple-choice", "true-false"].includes(resultType)) {
    return;
  }

  const choiceOptions = getChoiceOptions(question);
  if (choiceOptions.length === 0) {
    question.correctAnswer = "";
    return;
  }

  const isValidAnswer = choiceOptions.some((item) => normalizeText(item) === normalizeText(question.correctAnswer));
  if (!isValidAnswer) {
    question.correctAnswer = choiceOptions[0];
  }
}

// ── Interactive App helpers ────────────────────────────────────────────────

function escapeInteractiveHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeInteractiveColor(value, fallback = "#2563eb") {
  return /^#[0-9a-fA-F]{3,6}$/.test(String(value || "").trim()) ? String(value).trim() : fallback;
}

function parseLineList(text) {
  return String(text || "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

function splitCsvLine(line) {
  return String(line || "").split(",").map((part) => part.trim());
}

function parseNlPoints(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const value = Number.parseFloat(parts[0]);
      if (!Number.isFinite(value)) return null;
      return { value, label: parts[1] || "", color: parts[2] || "#2563eb" };
    })
    .filter(Boolean);
}

function parseNlArrows(text) {
  return parseLineList(text)
    .map((line) => {
      const match = line.match(/^(-?\d+(?:\.\d+)?)\s*(?:→|->|to)\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(.+))?$/i);
      if (!match) return null;
      return { from: Number.parseFloat(match[1]), to: Number.parseFloat(match[2]), label: match[3] ? match[3].trim() : "" };
    })
    .filter(Boolean);
}

function parseCartesianPoints(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const x = Number.parseFloat(parts[0]);
      const y = Number.parseFloat(parts[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return { x, y, label: parts[2] || "", color: parts[3] || "#2563eb" };
    })
    .filter(Boolean);
}

function parseCartesianSegments(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = line.split(/(?:→|->)/);
      if (parts.length !== 2) return null;
      const left = splitCsvLine(parts[0]);
      const right = splitCsvLine(parts[1]);
      const x1 = Number.parseFloat(left[0]);
      const y1 = Number.parseFloat(left[1]);
      const x2 = Number.parseFloat(right[0]);
      const y2 = Number.parseFloat(right[1]);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
      return { x1, y1, x2, y2, label: right[2] || "", color: right[3] || "#f59e0b" };
    })
    .filter(Boolean);
}

function parseCartesianParabolas(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 3) return null;
      const a = Number.parseFloat(parts[0]);
      const b = Number.parseFloat(parts[1]);
      const c = Number.parseFloat(parts[2]);
      if (![a, b, c].every(Number.isFinite)) return null;
      return {
        a,
        b,
        c,
        label: parts[3] || "",
        color: parts[4] || "#7c3aed"
      };
    })
    .filter(Boolean);
}

function parseCartesianFunctions(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const expression = String(parts[0] || "").trim();
      if (!expression) return null;
      return {
        expression,
        label: parts[1] || "",
        color: parts[2] || "#0f766e"
      };
    })
    .filter(Boolean);
}

function buildCartesianExpressionEvaluator(rawExpression) {
  let expression = String(rawExpression || "").trim();
  if (!expression) return null;
  expression = expression.replace(/^y\s*=\s*/i, "");
  if (!expression) return null;

  if (!/^[0-9a-zA-Z_+\-*/().,\s^%]+$/.test(expression)) {
    return null;
  }

  const lowered = expression.toLowerCase();
  const tokens = lowered.match(/[a-z_]+/g) || [];
  const allowed = new Set(["x", "sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "abs", "log", "ln", "exp", "pow", "pi", "e", "floor", "ceil", "round", "min", "max"]);
  if (!tokens.every((token) => allowed.has(token))) {
    return null;
  }

  let normalized = lowered
    .replace(/\^/g, "**")
    .replace(/(\d)\s*x\b/g, "$1*x")
    .replace(/\)\s*\(/g, ")*(")
    .replace(/\bx\s*\(/g, "x*(")
    .replace(/\)\s*x\b/g, ")*x")
    .replace(/\bpi\b/g, "PI")
    .replace(/\be\b/g, "E")
    .replace(/\bln\b/g, "log");

  try {
    const fn = new Function("x", "const {sin,cos,tan,asin,acos,atan,sqrt,abs,log,exp,pow,PI,E,floor,ceil,round,min,max}=Math; return (" + normalized + ");");
    return (x) => {
      const result = Number(fn(x));
      return Number.isFinite(result) ? result : Number.NaN;
    };
  } catch (error) {
    return null;
  }
}

function parseNumericList(text) {
  return String(text || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => Number.parseFloat(item))
    .filter((value) => Number.isFinite(value));
}

function defaultCartesianPlotPresetExpression(type) {
  if (type === "quadratic") return "x^2 - 4*x + 3";
  if (type === "cubic") return "x^3 - 2*x";
  if (type === "exponential") return "2^x";
  return "2*x + 1";
}

function defaultCartesianPlotPresetXValues(type) {
  if (type === "exponential") return "-2, -1, 0, 1, 2, 3";
  return "-2, -1, 0, 1, 2";
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function generateCartesianPlotPresetPoints(presetType, expression, xValuesText) {
  const evaluate = buildCartesianExpressionEvaluator(expression);
  if (!evaluate) {
    return { points: [], message: "Invalid expression. Use x, numbers, operators, and supported functions." };
  }

  const xValues = parseNumericList(xValuesText);
  if (xValues.length === 0) {
    return { points: [], message: "Add at least one numeric x value." };
  }

  const points = xValues
    .map((xValue, index) => {
      const yValue = evaluate(xValue);
      if (!Number.isFinite(yValue)) return null;
      const x = roundTo(xValue, 2);
      const y = roundTo(yValue, 2);
      const shortType = presetType === "quadratic" ? "Q" : presetType === "cubic" ? "C" : presetType === "exponential" ? "E" : "L";
      return { x, y, label: `${shortType}${index + 1}` };
    })
    .filter(Boolean);

  if (points.length === 0) {
    return { points: [], message: "No valid points were generated for those x values." };
  }

  return { points, message: "" };
}

function getCartesianPlotVceTemplate(templateId) {
  const templates = {
    "general-linear-intercepts": {
      presetType: "linear",
      expression: "2*x - 4",
      xValues: "0, 2, 4",
      xMin: -2,
      xMax: 6,
      yMin: -6,
      yMax: 6,
      tolerance: 0.5
    },
    "general-quadratic-turning-point": {
      presetType: "quadratic",
      expression: "x^2 - 4*x + 3",
      xValues: "1, 2, 3",
      xMin: -1,
      xMax: 5,
      yMin: -2,
      yMax: 8,
      tolerance: 0.5
    },
    "methods-transformed-parabola": {
      presetType: "quadratic",
      expression: "2*(x-1)^2 - 3",
      xValues: "-1, 1, 3",
      xMin: -3,
      xMax: 5,
      yMin: -5,
      yMax: 10,
      tolerance: 0.5
    },
    "methods-cubic-intercepts": {
      presetType: "cubic",
      expression: "x^3 - 4*x",
      xValues: "-2, 0, 2, -1, 1",
      xMin: -3,
      xMax: 3,
      yMin: -8,
      yMax: 8,
      tolerance: 0.5
    },
    "specialist-exponential-growth": {
      presetType: "exponential",
      expression: "2^x",
      xValues: "-2, -1, 0, 1, 2, 3",
      xMin: -3,
      xMax: 4,
      yMin: -1,
      yMax: 10,
      tolerance: 0.5
    }
  };
  return templates[templateId] || null;
}

const AUTO_CREATE_CARTESIAN_TEMPLATES = {
  linear: {
    easy: [
      { expression: "2*x - 4", xValues: "0, 2, 4", vceTemplate: "general-linear-intercepts" },
      { expression: "-x + 3", xValues: "0, 1, 3", vceTemplate: "general-linear-intercepts" }
    ],
    medium: [
      { expression: "3*x + 1", xValues: "-1, 0, 2", vceTemplate: "general-linear-intercepts" },
      { expression: "-2*x - 1", xValues: "-2, -1, 1", vceTemplate: "general-linear-intercepts" }
    ],
    hard: [
      { expression: "4*x - 7", xValues: "0, 1, 2", vceTemplate: "general-linear-intercepts" },
      { expression: "-3*x + 5", xValues: "0, 1, 2", vceTemplate: "general-linear-intercepts" }
    ]
  },
  quadratic: {
    easy: [
      { expression: "x^2 - 4*x + 3", xValues: "1, 2, 3", vceTemplate: "general-quadratic-turning-point" },
      { expression: "x^2 - 2*x - 3", xValues: "-1, 1, 3", vceTemplate: "general-quadratic-turning-point" }
    ],
    medium: [
      { expression: "2*(x-1)^2 - 3", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" },
      { expression: "-1*(x+2)^2 + 4", xValues: "-4, -2, 0", vceTemplate: "methods-transformed-parabola" }
    ],
    hard: [
      { expression: "0.5*(x-3)^2 - 5", xValues: "1, 3, 5", vceTemplate: "methods-transformed-parabola" },
      { expression: "-2*(x-1)^2 + 6", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" }
    ]
  },
  cubic: {
    easy: [
      { expression: "x^3 - 4*x", xValues: "-2, 0, 2, -1, 1", vceTemplate: "methods-cubic-intercepts" }
    ],
    medium: [
      { expression: "x^3 - x", xValues: "-1, 0, 1, -2, 2", vceTemplate: "methods-cubic-intercepts" },
      { expression: "x^3 - 3*x + 1", xValues: "-2, -1, 0, 1, 2", vceTemplate: "methods-cubic-intercepts" }
    ],
    hard: [
      { expression: "x^3 - 6*x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "methods-cubic-intercepts" },
      { expression: "0.5*x^3 - 2*x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "methods-cubic-intercepts" }
    ]
  },
  exponential: {
    easy: [
      { expression: "2^x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "specialist-exponential-growth" }
    ],
    medium: [
      { expression: "3^x", xValues: "-2, -1, 0, 1, 2", vceTemplate: "specialist-exponential-growth" },
      { expression: "2^(x-1)", xValues: "-1, 0, 1, 2, 3", vceTemplate: "specialist-exponential-growth" }
    ],
    hard: [
      { expression: "1.5^x", xValues: "-2, -1, 0, 1, 2, 3", vceTemplate: "specialist-exponential-growth" },
      { expression: "2^(x+1)", xValues: "-2, -1, 0, 1, 2", vceTemplate: "specialist-exponential-growth" }
    ]
  },
  transformations: {
    easy: [
      { expression: "(x-2)^2", xValues: "1, 2, 3", vceTemplate: "methods-transformed-parabola" },
      { expression: "(x+1)^2 - 2", xValues: "-2, -1, 0", vceTemplate: "methods-transformed-parabola" }
    ],
    medium: [
      { expression: "2*(x-1)^2 - 3", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" },
      { expression: "-1*(x+2)^2 + 4", xValues: "-4, -2, 0", vceTemplate: "methods-transformed-parabola" }
    ],
    hard: [
      { expression: "0.5*(x-3)^2 - 5", xValues: "1, 3, 5", vceTemplate: "methods-transformed-parabola" },
      { expression: "-2*(x-1)^2 + 6", xValues: "-1, 1, 3", vceTemplate: "methods-transformed-parabola" }
    ]
  },
  "domain-range": {
    easy: [
      { expression: "x^2", xValues: "-2, -1, 0, 1, 2", vceTemplate: "general-quadratic-turning-point" },
      { expression: "(x-1)^2 + 2", xValues: "-1, 0, 1, 2, 3", vceTemplate: "methods-transformed-parabola" }
    ],
    medium: [
      { expression: "-1*(x+2)^2 + 5", xValues: "-4, -3, -2, -1, 0", vceTemplate: "methods-transformed-parabola" },
      { expression: "2*(x-1)^2 - 3", xValues: "-1, 0, 1, 2, 3", vceTemplate: "methods-transformed-parabola" }
    ],
    hard: [
      { expression: "0.5*(x-3)^2 - 4", xValues: "1, 2, 3, 4, 5", vceTemplate: "methods-transformed-parabola" },
      { expression: "-2*(x-1)^2 + 7", xValues: "-1, 0, 1, 2, 3", vceTemplate: "methods-transformed-parabola" }
    ]
  },
  intercepts: {
    easy: [
      { expression: "x - 3", xValues: "0, 1, 3, 5", vceTemplate: "general-linear-graph" },
      { expression: "2*x + 4", xValues: "-3, -2, -1, 0", vceTemplate: "general-linear-graph" }
    ],
    medium: [
      { expression: "-3*x + 6", xValues: "0, 1, 2, 3", vceTemplate: "general-linear-graph" },
      { expression: "x^2 - 4", xValues: "-3, -2, 0, 2, 3", vceTemplate: "general-quadratic-turning-point" }
    ],
    hard: [
      { expression: "2*x - 5", xValues: "0, 1, 2, 3", vceTemplate: "general-linear-graph" },
      { expression: "x^2 - 2*x - 3", xValues: "-2, -1, 0, 1, 3", vceTemplate: "general-quadratic-turning-point" }
    ]
  },
  gradient: {
    easy: [
      { expression: "x + 1", xValues: "-1, 0, 1, 2", vceTemplate: "general-linear-graph" },
      { expression: "2*x - 1", xValues: "-1, 0, 1, 2", vceTemplate: "general-linear-graph" }
    ],
    medium: [
      { expression: "-3*x + 4", xValues: "-1, 0, 1", vceTemplate: "general-linear-graph" },
      { expression: "0.5*x - 2", xValues: "-2, 0, 2, 4", vceTemplate: "general-linear-graph" }
    ],
    hard: [
      { expression: "-2.5*x + 7", xValues: "0, 1, 2, 3", vceTemplate: "general-linear-graph" },
      { expression: "1.5*x - 4", xValues: "0, 2, 4", vceTemplate: "general-linear-graph" }
    ]
  },
  asymptotes: {
    easy: [
      { expression: "1/(x-2)", xValues: "-2, -1, 0, 1, 3, 4", vceTemplate: "specialist-rational-asymptote" },
      { expression: "1/(x+3)", xValues: "-5, -4, -2, -1, 0, 1", vceTemplate: "specialist-rational-asymptote" }
    ],
    medium: [
      { expression: "2/(x-1)", xValues: "-2, -1, 0, 2, 3, 4", vceTemplate: "specialist-rational-asymptote" },
      { expression: "-1/(x+2)", xValues: "-5, -4, -3, -1, 0, 1", vceTemplate: "specialist-rational-asymptote" }
    ],
    hard: [
      { expression: "1/(x-3) + 2", xValues: "0, 1, 2, 4, 5, 6", vceTemplate: "specialist-rational-asymptote" },
      { expression: "-2/(x+1) - 1", xValues: "-4, -3, -2, 0, 1, 2", vceTemplate: "specialist-rational-asymptote" }
    ]
  }
};

const AUTO_CREATE_SUBCATEGORY_OPTIONS = {
  "cartesian-plane": [
    { value: "linear", label: "Linear" },
    { value: "quadratic", label: "Quadratic" },
    { value: "cubic", label: "Cubic" },
    { value: "exponential", label: "Exponential" },
    { value: "transformations", label: "Transformations" },
    { value: "domain-range", label: "Domain and Range" },
    { value: "intercepts", label: "Intercepts" },
    { value: "gradient", label: "Gradient" },
    { value: "asymptotes", label: "Asymptotes" },
    { value: "point-on-axes", label: "Point On Axes" },
    { value: "quadrant-identification", label: "Quadrant Identification" }
  ],
  "cartesian-plane-plot": [
    { value: "linear", label: "Linear" },
    { value: "quadratic", label: "Quadratic" },
    { value: "cubic", label: "Cubic" },
    { value: "exponential", label: "Exponential" },
    { value: "transformations", label: "Transformations" },
    { value: "intercepts", label: "Intercepts" },
    { value: "gradient", label: "Gradient" },
    { value: "asymptotes", label: "Asymptotes" }
  ],
  "number-line": [{ value: "distance", label: "Distance Between Points" }],
  "bar-chart": [{ value: "highest-category", label: "Highest Category" }],
  "histogram": [{ value: "count-values", label: "Count Values" }],
  "box-plot": [{ value: "median", label: "Median Of Dataset" }],
  "scatter-plot": [{ value: "correlation-sign", label: "Correlation Sign" }],
  "probability-tree": [{ value: "path-sum", label: "Total Path Probability" }],
  "distribution-curve": [{ value: "mean", label: "Mean" }],
  arithmetic: [
    { value: "basic-addition-h", label: "Basic Addition - Horizontal" },
    { value: "basic-addition-v", label: "Basic Addition - Vertical" },
    { value: "basic-subtraction", label: "Basic Subtraction" },
    { value: "basic-multiplication", label: "Basic Multiplication" },
    { value: "division-short", label: "Division (Short)" },
    { value: "division-long", label: "Division (Long)" }
  ],
  "fractions": [{ value: "operation-result", label: "Operation Result" }],
  "network-graph": [{ value: "node-count", label: "Node Count" }],
  "matrix": [{ value: "matrix-a-dim", label: "Matrix A Dimensions" }],
  "stem-and-leaf": [{ value: "value-count", label: "Value Count" }],
  "geometry-shapes": [{ value: "shape-count", label: "Shape Count" }],
  "pythagoras": [{ value: "hypotenuse", label: "Find Hypotenuse" }],
  "trigonometry": [{ value: "focus-function", label: "Focus Function Ratio" }]
};

function populateAutoCreateSubcategoryOptions() {
  const categorySelect = document.getElementById("autoCreateCategory");
  const subcategorySelect = document.getElementById("autoCreateSubcategory");
  if (!categorySelect || !subcategorySelect) return;
  const category = String(categorySelect.value || "cartesian-plane").trim();
  const options = AUTO_CREATE_SUBCATEGORY_OPTIONS[category] || [{ value: "core", label: "Core" }];
  const current = String(subcategorySelect.value || "").trim();

  subcategorySelect.innerHTML = "";
  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    subcategorySelect.appendChild(option);
  });

  const hasCurrent = options.some((item) => item.value === current);
  subcategorySelect.value = hasCurrent ? current : options[0].value;
}

function updateAutoCreateCommandWordControl() {
  const categorySelect = document.getElementById("autoCreateCategory");
  const commandWordSelect = document.getElementById("autoCreateCommandWord");
  if (!(categorySelect instanceof HTMLSelectElement) || !(commandWordSelect instanceof HTMLSelectElement)) {
    return;
  }

  const category = String(categorySelect.value || "").trim().toLowerCase();
  const isArithmetic = category === "arithmetic";

  if (isArithmetic) {
    const current = normalizeCommandWordChoice(commandWordSelect.value || "");
    if (current !== "calculate") {
      commandWordSelect.dataset.previousChoice = current;
    }
    commandWordSelect.value = "calculate";
    commandWordSelect.disabled = true;
    commandWordSelect.title = "Arithmetic questions always use Calculate.";
    return;
  }

  commandWordSelect.disabled = false;
  const previous = normalizeCommandWordChoice(commandWordSelect.dataset.previousChoice || "random");
  commandWordSelect.value = previous === "calculate" ? "random" : previous;
  commandWordSelect.title = "";
}

function capitalizeWord(value) {
  const text = String(value || "").trim();
  if (!text) return "Determine";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase();
}

function normalizeCommandWordChoice(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["determine", "sketch", "interpret", "justify", "calculate", "random"].includes(normalized)) {
    return normalized;
  }
  return "determine";
}

function pickCommandWordFromChoice(choice, { resultType = "", index = 0, category = "" } = {}) {
  const normalizedCategory = String(category || "").trim().toLowerCase();
  if (normalizedCategory === "arithmetic") {
    return "calculate";
  }

  const normalizedChoice = normalizeCommandWordChoice(choice);
  if (normalizedChoice !== "random") {
    return normalizedChoice;
  }

  const normalizedResultType = String(resultType || "").trim().toLowerCase();
  if (normalizedResultType === "plot") {
    return "sketch";
  }

  const rotatingPool = ["determine", "interpret", "justify"];
  if (Number.isInteger(index)) {
    return rotatingPool[Math.abs(index) % rotatingPool.length];
  }

  return pickRandomItem(rotatingPool) || "determine";
}

function applyCommandWordToQuestion(questionText, commandWord) {
  const text = String(questionText || "").trim();
  const word = capitalizeWord(commandWord);
  if (!text) return `${word}.`;

  if (new RegExp(`^${word}\\b`, "i").test(text)) {
    return `${word}${text.slice(word.length)}`;
  }

  const normalized = text.charAt(0).toLowerCase() + text.slice(1);
  return `${word} ${normalized}`;
}

function formatAnswerValueByPolicy(value, policy, decimalPlaces) {
  const normalizedPolicy = String(policy || "auto").trim().toLowerCase();
  const places = Number.isInteger(Number(decimalPlaces))
    ? Math.max(0, Math.min(6, Number.parseInt(decimalPlaces, 10)))
    : 2;
  const raw = String(value || "").trim();
  if (!raw) return raw;

  if (normalizedPolicy === "exact" || normalizedPolicy === "auto") {
    return raw;
  }

  const numeric = Number.parseFloat(raw);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    return Number(numeric.toFixed(places)).toString();
  }

  const fractionMatch = raw.match(/^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/);
  if (fractionMatch && Number.parseInt(fractionMatch[2], 10) !== 0) {
    const numerator = Number.parseInt(fractionMatch[1], 10);
    const denominator = Number.parseInt(fractionMatch[2], 10);
    return Number((numerator / denominator).toFixed(places)).toString();
  }

  return raw;
}

function applyDomainRestrictionToPayload(payload, domainMin, domainMax) {
  if (!payload) return payload;
  const min = Number(domainMin);
  const max = Number(domainMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return payload;

  const next = { ...payload };
  next.question = `${String(payload.question || "").trim()} Restrict the domain to ${min} <= x <= ${max}.`;

  const app = payload.interactiveApp;
  if (app && app.config && Number.isFinite(Number(app.config.xMin)) && Number.isFinite(Number(app.config.xMax))) {
    next.interactiveApp = {
      ...app,
      config: {
        ...app.config,
        xMin: Math.max(Number(app.config.xMin), min),
        xMax: Math.min(Number(app.config.xMax), max)
      }
    };
  }

  return next;
}

function applyAnswerFormatToPayload(payload, policy, decimalPlaces) {
  if (!payload) return payload;
  const next = { ...payload };
  next.correctAnswer = formatAnswerValueByPolicy(next.correctAnswer, policy, decimalPlaces);

  if (Array.isArray(next.options) && next.options.length > 0) {
    next.options = next.options.map((item) => formatAnswerValueByPolicy(item, policy, decimalPlaces));
  }

  return next;
}

function postProcessAutoPayload(payload, generationOptions = {}) {
  if (!payload) return payload;
  const commandWordChoice = normalizeCommandWordChoice(generationOptions.commandWord || "determine");
  const commandWord = pickCommandWordFromChoice(commandWordChoice, {
    resultType: payload.resultType,
    index: Number.isInteger(generationOptions.questionIndex) ? generationOptions.questionIndex : null,
    category: generationOptions.category || ""
  });
  const answerPolicy = String(generationOptions.answerPolicy || "auto").trim();
  const decimalPlaces = Number.isInteger(Number(generationOptions.decimalPlaces))
    ? Number.parseInt(generationOptions.decimalPlaces, 10)
    : 2;
  const domainMin = generationOptions.domainMin;
  const domainMax = generationOptions.domainMax;

  let next = { ...payload };
  next.question = applyCommandWordToQuestion(next.question, commandWord);
  next = applyDomainRestrictionToPayload(next, domainMin, domainMax);
  next = applyAnswerFormatToPayload(next, answerPolicy, decimalPlaces);
  return next;
}

function pickRandomItem(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const index = Math.floor(Math.random() * list.length);
  return list[index] || null;
}

function computeAxisFromPoints(points) {
  const values = Array.isArray(points) ? points : [];
  if (values.length === 0) {
    return { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
  }
  const xs = values.map((item) => Number(item.x)).filter((item) => Number.isFinite(item));
  const ys = values.map((item) => Number(item.y)).filter((item) => Number.isFinite(item));
  if (xs.length === 0 || ys.length === 0) {
    return { xMin: -10, xMax: 10, yMin: -10, yMax: 10 };
  }
  const xMin = Math.floor(Math.min(...xs)) - 2;
  const xMax = Math.ceil(Math.max(...xs)) + 2;
  const yMin = Math.floor(Math.min(...ys)) - 2;
  const yMax = Math.ceil(Math.max(...ys)) + 2;
  return {
    xMin: Math.max(-12, xMin),
    xMax: Math.min(12, xMax),
    yMin: Math.max(-12, yMin),
    yMax: Math.min(12, yMax)
  };
}

function shuffleList(list) {
  const next = Array.isArray(list) ? list.slice() : [];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function formatCartesianPoint(point) {
  return `(${point.x}, ${point.y})`;
}

function buildCartesianDisplayApp(points) {
  const axis = computeAxisFromPoints(points);
  return {
    type: "cartesian-plane",
    config: {
      xMin: axis.xMin,
      xMax: axis.xMax,
      yMin: axis.yMin,
      yMax: axis.yMax,
      angleMode: "radians",
      points: points.map((point, index) => ({
        x: Number(point.x),
        y: Number(point.y),
        label: point.label || `P${index + 1}`,
        color: point.color || "#2563eb"
      })),
      segments: [],
      parabolas: [],
      functions: []
    }
  };
}

function buildCartesianFunctionDisplayApp(expression, xMin, xMax, yMin, yMax) {
  return {
    type: "cartesian-plane",
    config: {
      xMin: Number(xMin),
      xMax: Number(xMax),
      yMin: Number(yMin),
      yMax: Number(yMax),
      angleMode: "radians",
      points: [],
      segments: [],
      parabolas: [],
      functions: [{ expression: String(expression || "x"), label: `y = ${expression}`, color: "#0f766e" }]
    }
  };
}

function buildAutoCartesianPlotPayload(subcategory, difficulty) {
  const normalizedSubcategory = String(subcategory || "linear").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const bySubcategory = AUTO_CREATE_CARTESIAN_TEMPLATES[normalizedSubcategory] || AUTO_CREATE_CARTESIAN_TEMPLATES.linear;
  const options = bySubcategory[normalizedDifficulty] || bySubcategory.easy;
  const chosen = pickRandomItem(options) || options[0];
  if (!chosen) return null;

  const presetType = normalizedSubcategory === "quadratic"
    ? "quadratic"
    : normalizedSubcategory === "cubic"
      ? "cubic"
      : normalizedSubcategory === "exponential"
        ? "exponential"
        : normalizedSubcategory === "transformations"
          ? "quadratic"
        : normalizedSubcategory === "domain-range"
          ? "quadratic"
        : "linear";

  const generated = generateCartesianPlotPresetPoints(presetType, chosen.expression, chosen.xValues);
  if (generated.message || !Array.isArray(generated.points) || generated.points.length === 0) {
    return null;
  }

  const axis = computeAxisFromPoints(generated.points);
  const pointsSummary = generated.points.map((point) => formatCartesianPoint(point)).join(", ");
  const label = normalizedSubcategory.charAt(0).toUpperCase() + normalizedSubcategory.slice(1);

  if (normalizedSubcategory === "domain-range") {
    const yValues = generated.points.map((point) => Number(point.y)).filter((value) => Number.isFinite(value));
    const minY = yValues.length > 0 ? Math.min(...yValues) : 0;
    const maxY = yValues.length > 0 ? Math.max(...yValues) : 0;
    const domainText = `${axis.xMin} <= x <= ${axis.xMax}`;
    const rangeText = `${roundTo(minY, 2)} <= y <= ${roundTo(maxY, 2)}`;
    return {
      question: `Given the graph of y = ${chosen.expression} over ${domainText}, state the domain and range.`,
      resultType: "short-answer",
      options: ["", "", "", ""],
      correctAnswer: `Domain: ${domainText}; Range: ${rangeText}`,
      solution: `From the shown graph, x spans ${domainText}. The minimum y-value is ${roundTo(minY, 2)} and maximum y-value is ${roundTo(maxY, 2)}, so range is ${rangeText}.`,
      interactiveApp: {
        type: "cartesian-plane",
        config: {
          xMin: axis.xMin,
          xMax: axis.xMax,
          yMin: axis.yMin,
          yMax: axis.yMax,
          angleMode: "radians",
          points: generated.points.map((point, index) => ({
            x: point.x,
            y: point.y,
            label: index === 0 ? "sample" : "",
            color: "#2563eb"
          })),
          segments: [],
          parabolas: [],
          functions: [{ expression: chosen.expression, label: `y = ${chosen.expression}`, color: "#0f766e" }]
        }
      }
    };
  }

  return {
    question: `On the Cartesian plane, plot the ${label.toLowerCase()} graph y = ${chosen.expression}. Use the key points and place them accurately.`,
    resultType: "plot",
    options: ["", "", "", ""],
    correctAnswer: "",
    solution: [
      `Use y = ${chosen.expression}.`,
      `Substitute the key x-values ${chosen.xValues} to calculate y-values.`,
      `Key points: ${pointsSummary}.`,
      "Plot these points and sketch the curve/line through the correct shape."
    ].join(" "),
    interactiveApp: {
      type: "cartesian-plane-plot",
      config: {
        xMin: axis.xMin,
        xMax: axis.xMax,
        yMin: axis.yMin,
        yMax: axis.yMax,
        tolerance: 0.5,
        points: generated.points,
        vceTemplate: chosen.vceTemplate || "",
        presetType,
        presetExpression: chosen.expression,
        presetXValues: chosen.xValues
      }
    }
  };
}

function buildAutoCartesianMcqPayload(subcategory, difficulty) {
  const normalizedSubcategory = String(subcategory || "point-on-axes").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();

  if (normalizedSubcategory === "gradient") {
    const pools = normalizedDifficulty === "hard"
      ? [{ m: -2.5, b: 7 }, { m: 1.5, b: -4 }, { m: -3.5, b: 5 }]
      : normalizedDifficulty === "medium"
        ? [{ m: -3, b: 4 }, { m: 0.5, b: -2 }, { m: 2.5, b: 1 }]
        : [{ m: 1, b: 1 }, { m: 2, b: -1 }, { m: -1, b: 3 }];
    const chosen = pickRandomItem(pools);
    const gradient = roundTo(chosen.m, 2);
    const expression = `${chosen.m}*x ${chosen.b >= 0 ? "+" : "-"} ${Math.abs(chosen.b)}`;
    const distractors = shuffleList([
      String(roundTo(-gradient, 2)),
      String(roundTo(gradient + 1, 2)),
      String(roundTo(gradient - 1, 2)),
      String(roundTo(chosen.b, 2))
    ].filter((item) => Number(item) !== Number(gradient))).slice(0, 3);
    const correctOption = String(gradient);
    const options = shuffleList([correctOption, ...distractors]).slice(0, 4);

    return {
      question: `What is the gradient of the line y = ${expression}?`,
      resultType: "multiple-choice",
      options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
      correctAnswer: correctOption,
      solution: `In y = mx + c form, the gradient is the coefficient of x. So the gradient is ${correctOption}.`,
      interactiveApp: buildCartesianFunctionDisplayApp(expression, -6, 6, -10, 10)
    };
  }

  if (normalizedSubcategory === "intercepts") {
    const pools = normalizedDifficulty === "hard"
      ? [{ m: 2, b: -5 }, { m: -3, b: 7 }, { m: 4, b: -9 }]
      : normalizedDifficulty === "medium"
        ? [{ m: 2, b: 4 }, { m: -3, b: 6 }, { m: 1, b: -4 }]
        : [{ m: 1, b: -3 }, { m: 2, b: 4 }, { m: -1, b: 2 }];
    const chosen = pickRandomItem(pools);
    const expression = `${chosen.m}*x ${chosen.b >= 0 ? "+" : "-"} ${Math.abs(chosen.b)}`;
    const xIntercept = roundTo((-chosen.b) / chosen.m, 2);
    const correctOption = formatCartesianPoint({ x: xIntercept, y: 0 });
    const distractorPool = [
      formatCartesianPoint({ x: roundTo(chosen.b / chosen.m, 2), y: 0 }),
      formatCartesianPoint({ x: 0, y: roundTo(chosen.b, 2) }),
      formatCartesianPoint({ x: roundTo(xIntercept + 1, 2), y: 0 }),
      formatCartesianPoint({ x: roundTo(xIntercept - 1, 2), y: 0 })
    ].filter((item) => item !== correctOption);
    const options = shuffleList([correctOption, ...distractorPool]).slice(0, 4);

    return {
      question: `What is the x-intercept of y = ${expression}?`,
      resultType: "multiple-choice",
      options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
      correctAnswer: correctOption,
      solution: `Set y = 0, so 0 = ${chosen.m}x ${chosen.b >= 0 ? "+" : "-"} ${Math.abs(chosen.b)}. Solving gives x = ${xIntercept}, so the intercept is ${correctOption}.`,
      interactiveApp: buildCartesianFunctionDisplayApp(expression, -8, 8, -10, 10)
    };
  }

  if (normalizedSubcategory === "asymptotes") {
    const pools = normalizedDifficulty === "hard"
      ? [{ a: 3, k: 2, p: 1 }, { a: -1, k: -1, p: -2 }]
      : normalizedDifficulty === "medium"
        ? [{ a: 1, k: 0, p: 2 }, { a: -2, k: 0, p: -1 }]
        : [{ a: 2, k: 0, p: 1 }, { a: -3, k: 0, p: 1 }];
    const chosen = pickRandomItem(pools);
    const expression = chosen.k === 0
      ? `${chosen.p}/(x${chosen.a >= 0 ? "-" : "+"}${Math.abs(chosen.a)})`
      : `${chosen.p}/(x${chosen.a >= 0 ? "-" : "+"}${Math.abs(chosen.a)}) ${chosen.k >= 0 ? "+" : "-"} ${Math.abs(chosen.k)}`;
    const correctOption = `x = ${chosen.a}`;
    const distractors = shuffleList([
      `x = ${-chosen.a}`,
      `y = ${chosen.a}`,
      `y = ${chosen.k}`,
      `x = ${chosen.a + 1}`
    ].filter((item) => item !== correctOption)).slice(0, 3);
    const options = shuffleList([correctOption, ...distractors]).slice(0, 4);

    return {
      question: `What is the vertical asymptote of y = ${expression}?`,
      resultType: "multiple-choice",
      options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
      correctAnswer: correctOption,
      solution: `A vertical asymptote occurs where the denominator is zero. For y = ${expression}, x ${chosen.a >= 0 ? "-" : "+"} ${Math.abs(chosen.a)} = 0, so x = ${chosen.a}.`,
      interactiveApp: buildCartesianFunctionDisplayApp(expression, -8, 8, -8, 8)
    };
  }

  if (normalizedSubcategory === "quadrant-identification") {
    const bases = normalizedDifficulty === "hard"
      ? [{ x: 5, y: -7 }, { x: -8, y: 6 }, { x: -6, y: -5 }, { x: 7, y: 9 }]
      : normalizedDifficulty === "medium"
        ? [{ x: 4, y: -3 }, { x: -5, y: 4 }, { x: -3, y: -4 }, { x: 6, y: 5 }]
        : [{ x: 2, y: 3 }, { x: -4, y: 2 }, { x: -3, y: -2 }, { x: 4, y: -1 }];
    const chosen = pickRandomItem(bases);
    const quadrant = chosen.x > 0 && chosen.y > 0
      ? "Quadrant I"
      : chosen.x < 0 && chosen.y > 0
        ? "Quadrant II"
        : chosen.x < 0 && chosen.y < 0
          ? "Quadrant III"
          : "Quadrant IV";
    const distractors = shuffleList(["Quadrant I", "Quadrant II", "Quadrant III", "Quadrant IV"].filter((item) => item !== quadrant)).slice(0, 3);
    const mcq = shuffleList([quadrant, ...distractors]);

    return {
      question: `In which quadrant is the point ${formatCartesianPoint(chosen)} located?`,
      resultType: "multiple-choice",
      options: [mcq[0] || "", mcq[1] || "", mcq[2] || "", mcq[3] || ""],
      correctAnswer: quadrant,
      solution: `${formatCartesianPoint(chosen)} has ${chosen.x > 0 ? "positive" : "negative"} x and ${chosen.y > 0 ? "positive" : "negative"} y, so it lies in ${quadrant}.`,
      interactiveApp: buildCartesianDisplayApp([
        { x: chosen.x, y: chosen.y, label: "P", color: "#2563eb" }
      ])
    };
  }

  const axisPoints = normalizedDifficulty === "hard"
    ? [{ x: 0, y: 9 }, { x: -8, y: 0 }, { x: 0, y: -7 }, { x: 6, y: 0 }]
    : normalizedDifficulty === "medium"
      ? [{ x: 0, y: 6 }, { x: -5, y: 0 }, { x: 0, y: -4 }, { x: 3, y: 0 }]
      : [{ x: 0, y: 3 }, { x: -2, y: 0 }, { x: 0, y: -2 }, { x: 4, y: 0 }];
  const target = pickRandomItem(axisPoints);
  const axisName = target.x === 0 ? "y-axis" : "x-axis";
  const distractorPool = [
    { x: target.x === 0 ? 1 : 0, y: target.y === 0 ? 1 : 0 },
    { x: target.x === 0 ? -2 : 2, y: target.y === 0 ? 2 : -2 },
    { x: target.x === 0 ? 3 : -3, y: target.y === 0 ? -1 : 4 }
  ];
  const distractors = shuffleList(distractorPool).slice(0, 3).map((point) => formatCartesianPoint(point));
  const correctOption = formatCartesianPoint(target);
  const options = shuffleList([correctOption, ...distractors]);
  return {
    question: `Which point lies on the ${axisName}?`,
    resultType: "multiple-choice",
    options: [options[0] || "", options[1] || "", options[2] || "", options[3] || ""],
    correctAnswer: correctOption,
    solution: `Points on the ${axisName} have ${axisName === "y-axis" ? "x = 0" : "y = 0"}. Therefore ${correctOption} is correct.`,
    interactiveApp: buildCartesianDisplayApp([
      { x: target.x, y: target.y, label: "A", color: "#16a34a" },
      ...distractorPool.map((point, index) => ({ x: point.x, y: point.y, label: `D${index + 1}`, color: "#dc2626" }))
    ])
  };
}

function buildAutoCartesianTrueFalsePayload(subcategory, difficulty) {
  const mcqPayload = buildAutoCartesianMcqPayload(subcategory, difficulty);
  if (!mcqPayload) return null;
  const correctPoint = String(mcqPayload.correctAnswer || "").trim();
  const wrongPoint = (mcqPayload.options || []).find((item) => String(item).trim() && String(item).trim() !== correctPoint) || "(1, 1)";
  const statementIsTrue = Math.random() < 0.5;
  const isQuadrantQuestion = String(subcategory || "").trim().toLowerCase() === "quadrant-identification";

  let statement = "";
  let solution = "";
  if (isQuadrantQuestion) {
    const expected = correctPoint;
    const shown = statementIsTrue ? expected : wrongPoint;
    statement = `The point in this question lies in ${shown}.`;
    solution = statementIsTrue
      ? `True. The point is in ${expected}.`
      : `False. The correct quadrant is ${expected}.`;
  } else {
    const axisName = mcqPayload.question.includes("y-axis") ? "y-axis" : "x-axis";
    const shownPoint = statementIsTrue ? correctPoint : wrongPoint;
    statement = `${shownPoint} lies on the ${axisName}.`;
    solution = statementIsTrue
      ? `True. ${shownPoint} satisfies the ${axisName === "y-axis" ? "x = 0" : "y = 0"} rule.`
      : `False. The point that lies on the ${axisName} is ${correctPoint}.`;
  }

  return {
    question: statement,
    resultType: "true-false",
    options: ["True", "False", "", ""],
    correctAnswer: statementIsTrue ? "True" : "False",
    solution,
    interactiveApp: mcqPayload.interactiveApp
  };
}

function buildMcqOptionsFromAnswer(correctAnswer) {
  const raw = String(correctAnswer || "").trim();
  if (!raw) return ["Option A", "Option B", "Option C", "Option D"];

  const fractionMatch = raw.match(/^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/);
  if (fractionMatch) {
    const numerator = Number.parseInt(fractionMatch[1], 10);
    const denominator = Number.parseInt(fractionMatch[2], 10);
    if (denominator !== 0) {
      const variants = [
        `${numerator}/${denominator}`,
        `${-numerator}/${denominator}`,
        `${numerator}/${Math.max(1, denominator + 1)}`,
        `${numerator + 1}/${denominator}`
      ];
      return shuffleList(Array.from(new Set(variants))).slice(0, 4);
    }
  }

  const numeric = Number.parseFloat(raw);
  if (Number.isFinite(numeric) && /^-?\d+(?:\.\d+)?$/.test(raw)) {
    const variants = [numeric, -numeric, numeric + 1, numeric - 1, numeric + 2]
      .map((value) => String(roundTo(value, 2)));
    return shuffleList(Array.from(new Set(variants))).slice(0, 4);
  }

  if (/^quadrant\s+[ivx]+$/i.test(raw)) {
    const variants = ["Quadrant I", "Quadrant II", "Quadrant III", "Quadrant IV"];
    return shuffleList(Array.from(new Set([raw, ...variants]))).slice(0, 4);
  }

  if (/^\(.+,.+\)$/.test(raw)) {
    const match = raw.match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
    if (match) {
      const x = Number.parseFloat(match[1]);
      const y = Number.parseFloat(match[2]);
      const points = [
        `(${x}, ${y})`,
        `(${y}, ${x})`,
        `(${x + 1}, ${y})`,
        `(${x}, ${y + 1})`,
        `(${x - 1}, ${y - 1})`
      ];
      return shuffleList(points);
    }
  }
  const textOptions = [raw, "None of the above", "Cannot be determined", "All of the above"];
  return shuffleList(Array.from(new Set(textOptions))).slice(0, 4);
}

function asResultTypePayload(base, desiredResultType) {
  const cleanBase = { ...base };
  delete cleanBase._generation;
  const resultType = normalizeResultType(desiredResultType || "short-answer");
  const answerPolicy = base && base._generation ? base._generation.answerPolicy : "auto";
  const decimalPlaces = base && base._generation ? base._generation.decimalPlaces : 2;
  const answerText = formatAnswerValueByPolicy(String(base.correctAnswer || "").trim(), answerPolicy, decimalPlaces);

  if (resultType === "multiple-choice") {
    const options = buildMcqOptionsFromAnswer(answerText);
    if (!options.some((item) => normalizeText(item) === normalizeText(answerText))) {
      options[0] = answerText || options[0];
    }
    return {
      ...cleanBase,
      resultType: "multiple-choice",
      options,
      correctAnswer: options.find((item) => normalizeText(item) === normalizeText(answerText)) || answerText
    };
  }

  if (resultType === "true-false") {
    const statementIsTrue = Math.random() < 0.5;
    const statement = statementIsTrue
      ? `The correct answer is ${answerText}.`
      : `The correct answer is not ${answerText}.`;
    return {
      ...cleanBase,
      question: `${base.question} ${statement}`,
      resultType: "true-false",
      options: ["True", "False", "", ""],
      correctAnswer: statementIsTrue ? "True" : "False",
      solution: statementIsTrue
        ? `${base.solution} Therefore the statement is True.`
        : `${base.solution} Therefore the statement is False.`
    };
  }

  return {
    ...cleanBase,
    resultType: resultType === "plot" ? "plot" : "short-answer",
    options: ["", "", "", ""],
    correctAnswer: answerText
  };
}

function extractFirstFiniteNumber(text) {
  const match = String(text || "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return Number.NaN;
  return Number.parseFloat(match[0]);
}

function extractArithmeticExpectedAnswer(questionText) {
  const text = String(questionText || "");
  let match = text.match(/(-?\d+(?:\.\d+)?)\s*\+\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return Number.parseFloat(match[1]) + Number.parseFloat(match[2]);
  }

  match = text.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    return Number.parseFloat(match[1]) - Number.parseFloat(match[2]);
  }

  match = text.match(/(-?\d+(?:\.\d+)?)\s*[x*]\s*(-?\d+(?:\.\d+)?)/i);
  if (match) {
    return Number.parseFloat(match[1]) * Number.parseFloat(match[2]);
  }

  match = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (match) {
    const denominator = Number.parseFloat(match[2]);
    if (Math.abs(denominator) < 1e-9) return Number.NaN;
    return Number.parseFloat(match[1]) / denominator;
  }

  match = text.match(/divide\s+(-?\d+(?:\.\d+)?)\s+by\s+(-?\d+(?:\.\d+)?)/i);
  if (match) {
    const denominator = Number.parseFloat(match[2]);
    if (Math.abs(denominator) < 1e-9) return Number.NaN;
    return Number.parseFloat(match[1]) / denominator;
  }

  return Number.NaN;
}

function parseCartesianPointText(value) {
  const match = String(value || "").trim().match(/^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
  if (!match) return null;
  const x = Number.parseFloat(match[1]);
  const y = Number.parseFloat(match[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

function verifyAutoPayload(category, subcategory, payload) {
  const issues = [];
  const appType = String(category || "").trim();
  const normalizedSubcategory = String(subcategory || "").trim().toLowerCase();
  const structural = getQuestionValidationIssues(payload || {});
  if (structural.length > 0) {
    issues.push(...structural);
  }

  const questionText = String(payload && payload.question || "").trim();
  const solutionText = String(payload && payload.solution || "").trim();
  if (!questionText) issues.push("Generated question text is empty.");
  if (!solutionText) issues.push("Generated solution text is empty.");

  const app = payload && payload.interactiveApp ? payload.interactiveApp : null;
  if ((appType === "cartesian-plane" || appType === "cartesian-plane-plot") && !app) {
    issues.push("Generated payload is missing interactive app configuration.");
  }

  // Verify plotted points satisfy their source expression when preset metadata exists.
  if (app && app.type === "cartesian-plane-plot") {
    const cfg = app.config || {};
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    if (points.length === 0) {
      issues.push("Cartesian plot payload has no answer points.");
    }
    if (cfg.presetExpression && cfg.presetXValues) {
      const regenerated = generateCartesianPlotPresetPoints(
        String(cfg.presetType || "linear").trim() || "linear",
        String(cfg.presetExpression || "").trim(),
        String(cfg.presetXValues || "").trim()
      );
      if (regenerated.message) {
        issues.push(`Could not verify plot points: ${regenerated.message}`);
      } else {
        const expected = regenerated.points || [];
        if (expected.length !== points.length) {
          issues.push("Plot verification failed: generated points count does not match answer points.");
        } else {
          const tolerance = 0.01;
          const mismatched = expected.some((ep) =>
            !points.some((ap) => Math.abs(Number(ap.x) - Number(ep.x)) <= tolerance && Math.abs(Number(ap.y) - Number(ep.y)) <= tolerance)
          );
          if (mismatched) {
            issues.push("Plot verification failed: answer points do not match computed expression points.");
          }
        }
      }
    }
  }

  // Subcategory-specific semantic checks for deterministic Cartesian MCQ generation.
  if (appType === "cartesian-plane" && app && app.type === "cartesian-plane") {
    const functionExpr = app.config && Array.isArray(app.config.functions) && app.config.functions[0]
      ? String(app.config.functions[0].expression || "").trim()
      : "";
    const evaluator = functionExpr ? buildCartesianExpressionEvaluator(functionExpr) : null;

    if (normalizedSubcategory === "gradient" && evaluator) {
      const y0 = evaluator(0);
      const y1 = evaluator(1);
      if (Number.isFinite(y0) && Number.isFinite(y1)) {
        const expectedGradient = roundTo(y1 - y0, 2);
        const actualGradient = extractFirstFiniteNumber(payload.correctAnswer);
        if (!Number.isFinite(actualGradient) || Math.abs(actualGradient - expectedGradient) > 0.01) {
          issues.push(`Gradient verification failed: expected ${expectedGradient}, got ${payload.correctAnswer}.`);
        }
      }
    }

    if (normalizedSubcategory === "intercepts" && evaluator) {
      const y0 = evaluator(0);
      const y1 = evaluator(1);
      const m = y1 - y0;
      const b = y0;
      if (Number.isFinite(m) && Math.abs(m) > 1e-9 && Number.isFinite(b)) {
        const expectedX = roundTo((-b) / m, 2);
        const actualPoint = parseCartesianPointText(payload.correctAnswer);
        if (!actualPoint || Math.abs(actualPoint.x - expectedX) > 0.01 || Math.abs(actualPoint.y) > 0.01) {
          issues.push(`Intercept verification failed: expected (${expectedX}, 0), got ${payload.correctAnswer}.`);
        }
      }
    }

    if (normalizedSubcategory === "asymptotes") {
      const match = functionExpr.match(/\/\(\s*x\s*([+-])\s*(\d+(?:\.\d+)?)\s*\)/i);
      const expectedA = match
        ? (match[1] === "-" ? Number.parseFloat(match[2]) : -Number.parseFloat(match[2]))
        : Number.NaN;
      const answerNumber = extractFirstFiniteNumber(payload.correctAnswer);
      if (Number.isFinite(expectedA) && (!Number.isFinite(answerNumber) || Math.abs(answerNumber - expectedA) > 0.01)) {
        issues.push(`Asymptote verification failed: expected x = ${expectedA}, got ${payload.correctAnswer}.`);
      }
    }

    if (normalizedSubcategory === "domain-range") {
      const cfg = app.config || {};
      const points = Array.isArray(cfg.points) ? cfg.points : [];
      const yValues = points.map((point) => Number(point.y)).filter((value) => Number.isFinite(value));
      const expectedDomain = `${cfg.xMin} <= x <= ${cfg.xMax}`;
      const expectedRange = yValues.length > 0
        ? `${roundTo(Math.min(...yValues), 2)} <= y <= ${roundTo(Math.max(...yValues), 2)}`
        : "";
      const answerText = String(payload.correctAnswer || "");
      if (!answerText.includes(expectedDomain) || (expectedRange && !answerText.includes(expectedRange))) {
        issues.push("Domain/range verification failed: correct answer text does not match computed domain/range.");
      }
    }
  }

  if (appType === "arithmetic") {
    const expected = extractArithmeticExpectedAnswer(questionText);
    if (!Number.isFinite(expected)) {
      issues.push("Arithmetic verification failed: could not parse arithmetic expression from question text.");
    } else {
      const resultType = normalizeResultType(payload && payload.resultType);
      const tolerance = 0.01;

      if (resultType === "true-false") {
        const statementMatch = questionText.match(/the\s+correct\s+answer\s+is\s+(not\s+)?(-?\d+(?:\.\d+)?)/i);
        if (!statementMatch) {
          issues.push("Arithmetic verification failed: true/false statement is missing a numeric claim.");
        } else {
          const isNegated = Boolean(statementMatch[1]);
          const claimed = Number.parseFloat(statementMatch[2]);
          const shouldBeTrue = isNegated
            ? Math.abs(expected - claimed) > tolerance
            : Math.abs(expected - claimed) <= tolerance;
          const markedTrue = normalizeText(payload.correctAnswer) === "true";
          if (shouldBeTrue !== markedTrue) {
            issues.push(`Arithmetic true/false verification failed: expected ${shouldBeTrue ? "True" : "False"}, got ${payload.correctAnswer}.`);
          }
        }
      } else {
        const actual = extractFirstFiniteNumber(payload && payload.correctAnswer);
        if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
          issues.push(`Arithmetic verification failed: expected ${roundTo(expected, 2)}, got ${payload && payload.correctAnswer}.`);
        }
      }
    }
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

function randomIntBetween(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function deriveYearLevelFromGenerationOptions(generationOptions = {}) {
  const explicitYear = String(generationOptions.yearValue || "").trim().toLowerCase();
  if (explicitYear === "prep") return 0;
  if (/^\d+$/.test(explicitYear)) {
    return Number.parseInt(explicitYear, 10);
  }

  const grade = String(generationOptions.gradeValue || "").trim().toLowerCase();
  if (grade === "prep") return 0;
  const yearMatch = grade.match(/^year-(\d+)$/);
  if (yearMatch) {
    return Number.parseInt(yearMatch[1], 10);
  }

  return null;
}

function resolveArithmeticRanges(normalizedDifficulty, generationOptions = {}) {
  const defaultRanges = normalizedDifficulty === "hard"
    ? { add: [60, 500], sub: [80, 600], mul: [8, 24], div: [6, 24] }
    : normalizedDifficulty === "medium"
      ? { add: [20, 200], sub: [30, 250], mul: [4, 15], div: [3, 15] }
      : { add: [1, 50], sub: [1, 80], mul: [2, 10], div: [2, 10] };

  const yearLevel = deriveYearLevelFromGenerationOptions(generationOptions);
  if (yearLevel === null) {
    return defaultRanges;
  }

  if (yearLevel === 0) {
    return { add: [0, 10], sub: [0, 10], mul: [1, 5], div: [1, 5] };
  }

  if (yearLevel === 1) {
    return { add: [1, 10], sub: [1, 20], mul: [1, 5], div: [1, 5] };
  }

  if (yearLevel === 2) {
    return { add: [1, 20], sub: [1, 50], mul: [2, 10], div: [2, 10] };
  }

  if (yearLevel <= 4) {
    return { add: [5, 80], sub: [5, 120], mul: [2, 12], div: [2, 12] };
  }

  return defaultRanges;
}

function buildAutoArithmeticPayload(subcategory, difficulty, generationOptions = {}) {
  const normalizedSubcategory = String(subcategory || "basic-addition").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const ranges = resolveArithmeticRanges(normalizedDifficulty, generationOptions);

  if (["basic-addition", "basic-addition-h", "basic-addition-v"].includes(normalizedSubcategory)) {
    const a = randomIntBetween(ranges.add[0], ranges.add[1]);
    const b = randomIntBetween(ranges.add[0], ranges.add[1]);
    const answer = a + b;
    const layout = normalizedSubcategory === "basic-addition-v" ? "vertical" : "horizontal";
    return {
      question: `Calculate ${a} + ${b}.`,
      solution: `Add the numbers: ${a} + ${b} = ${answer}.`,
      correctAnswer: String(answer),
      interactiveApp: {
        type: "arithmetic",
        config: {
          layout,
          operator: "+",
          operandA: a,
          operandB: b,
          answer: String(answer),
          answerDigits: String(answer).length
        }
      }
    };
  }

  if (normalizedSubcategory === "basic-subtraction") {
    const a = randomIntBetween(ranges.sub[0], ranges.sub[1]);
    const b = randomIntBetween(ranges.sub[0], Math.max(ranges.sub[0], Math.floor(a * 0.9)));
    const top = Math.max(a, b);
    const bottom = Math.min(a, b);
    const answer = top - bottom;
    return {
      question: `Calculate ${top} - ${bottom}.`,
      solution: `Subtract ${bottom} from ${top}: ${top} - ${bottom} = ${answer}.`,
      correctAnswer: String(answer),
      interactiveApp: null
    };
  }

  if (normalizedSubcategory === "basic-multiplication") {
    const a = randomIntBetween(ranges.mul[0], ranges.mul[1]);
    const b = randomIntBetween(ranges.mul[0], ranges.mul[1]);
    const answer = a * b;
    return {
      question: `Calculate ${a} x ${b}.`,
      solution: `Multiply: ${a} x ${b} = ${answer}.`,
      correctAnswer: String(answer),
      interactiveApp: null
    };
  }

  if (normalizedSubcategory === "division-short") {
    const divisor = randomIntBetween(ranges.div[0], ranges.div[1]);
    const quotient = randomIntBetween(ranges.div[0], ranges.div[1] + 10);
    const dividend = divisor * quotient;
    return {
      question: `Use short division to calculate ${dividend} / ${divisor}.`,
      solution: `Since ${divisor} x ${quotient} = ${dividend}, the quotient is ${quotient}.`,
      correctAnswer: String(quotient),
      interactiveApp: null
    };
  }

  if (normalizedSubcategory === "division-long") {
    const divisor = randomIntBetween(ranges.div[0], ranges.div[1]);
    const quotient = randomIntBetween(ranges.div[0] + 4, ranges.div[1] + 20);
    const dividend = divisor * quotient;
    return {
      question: `Use long division to divide ${dividend} by ${divisor}.`,
      solution: `Long division gives quotient ${quotient} because ${divisor} x ${quotient} = ${dividend} with remainder 0.`,
      correctAnswer: String(quotient),
      interactiveApp: null
    };
  }

  return null;
}

function buildAutoPayloadForCategory(category, subcategory, difficulty, resultTypeChoice = "auto", generationOptions = {}) {
  const appType = String(category || "cartesian-plane").trim();
  const desired = String(resultTypeChoice || "auto").trim().toLowerCase();

  if (appType === "cartesian-plane") {
    return postProcessAutoPayload(
      buildAutoCreatedQuestionPayload(subcategory, difficulty, resultTypeChoice),
      generationOptions
    );
  }
  if (appType === "cartesian-plane-plot") {
    return postProcessAutoPayload(
      buildAutoCartesianPlotPayload(subcategory, difficulty),
      generationOptions
    );
  }
  if (appType === "arithmetic") {
    const base = buildAutoArithmeticPayload(subcategory, difficulty, generationOptions);
    if (!base) return null;
    const defaultResult = desired === "auto" ? "short-answer" : desired;
    return postProcessAutoPayload(
      asResultTypePayload(
        {
          ...base,
          _generation: {
            answerPolicy: generationOptions.answerPolicy || "auto",
            decimalPlaces: generationOptions.decimalPlaces
          }
        },
        defaultResult
      ),
      generationOptions
    );
  }

  const app = buildDefaultInteractiveApp(appType);
  if (!app) return null;

  const cfg = app.config || {};
  const defaultResult = desired === "auto" ? "short-answer" : desired;
  let base = null;

  if (appType === "number-line") {
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    const first = points[0] || { value: -3, label: "A" };
    const second = points[1] || { value: 5, label: "B" };
    const distance = Math.abs(Number(second.value) - Number(first.value));
    base = {
      question: `On the number line, what is the distance between ${first.label || "A"} and ${second.label || "B"}?`,
      solution: `Distance = |${second.value} - ${first.value}| = ${distance}.`,
      correctAnswer: String(distance),
      interactiveApp: app
    };
  } else if (appType === "bar-chart") {
    const items = Array.isArray(cfg.items) ? cfg.items : [];
    const top = items.slice().sort((a, b) => Number(b.frequency || 0) - Number(a.frequency || 0))[0] || { category: "Cats", frequency: 8 };
    base = {
      question: "Which category has the highest frequency in the bar chart?",
      solution: `The largest bar is ${top.category} with frequency ${top.frequency}.`,
      correctAnswer: String(top.category || ""),
      interactiveApp: app
    };
  } else if (appType === "histogram") {
    const values = Array.isArray(cfg.values) ? cfg.values : [];
    base = {
      question: "How many data values are represented in the histogram dataset?",
      solution: `There are ${values.length} values in the dataset.`,
      correctAnswer: String(values.length),
      interactiveApp: app
    };
  } else if (appType === "box-plot") {
    const datasets = normalizeBoxPlotDatasets(cfg);
    const first = datasets[0] || { label: "A", values: [1, 2, 3] };
    const stats = computeFiveNumber(first.values || []);
    const median = stats ? roundTo(stats.median, 2) : 0;
    base = {
      question: `What is the median of dataset ${first.label || "A"} in the box plot?`,
      solution: `For dataset ${first.label || "A"}, the median is ${median}.`,
      correctAnswer: String(median),
      interactiveApp: app
    };
  } else if (appType === "scatter-plot") {
    const points = Array.isArray(cfg.points) ? cfg.points : [];
    const regression = computeLinearRegression(points);
    const trend = !regression ? "no clear" : regression.correlation > 0 ? "positive" : regression.correlation < 0 ? "negative" : "no";
    base = {
      question: "What type of correlation does the scatter plot show?",
      solution: `The data trend is ${trend} correlation.`,
      correctAnswer: trend === "no" ? "no correlation" : `${trend} correlation`,
      interactiveApp: app
    };
  } else if (appType === "probability-tree") {
    const paths = Array.isArray(cfg.paths) ? cfg.paths : [];
    const total = roundTo(paths.reduce((sum, path) => sum + Number(path.probability || 0), 0), 3);
    base = {
      question: "What is the total probability of all listed paths?",
      solution: `Sum of listed path probabilities = ${total}.`,
      correctAnswer: String(total),
      interactiveApp: app
    };
  } else if (appType === "distribution-curve") {
    base = {
      question: "What is the mean of the normal distribution shown?",
      solution: `The mean parameter shown is ${cfg.mean}.`,
      correctAnswer: String(cfg.mean),
      interactiveApp: app
    };
  } else if (appType === "fractions") {
    const operation = normalizeFractionOperation(cfg.operation);
    const a = simplifyFraction(cfg.fractionA && cfg.fractionA.numerator, cfg.fractionA && cfg.fractionA.denominator);
    const b = simplifyFraction(cfg.fractionB && cfg.fractionB.numerator, cfg.fractionB && cfg.fractionB.denominator);
    let numerator = 0;
    let denominator = 1;
    if (operation === "add") {
      numerator = a.numerator * b.denominator + b.numerator * a.denominator;
      denominator = a.denominator * b.denominator;
    } else if (operation === "subtract") {
      numerator = a.numerator * b.denominator - b.numerator * a.denominator;
      denominator = a.denominator * b.denominator;
    } else if (operation === "multiply") {
      numerator = a.numerator * b.numerator;
      denominator = a.denominator * b.denominator;
    } else {
      numerator = a.numerator * b.denominator;
      denominator = a.denominator * b.numerator;
    }
    const result = simplifyFraction(numerator, denominator);
    const resultText = `${result.numerator}/${result.denominator}`;
    base = {
      question: "What is the simplified result of the fraction operation shown?",
      solution: `Applying the ${operation} operation gives ${resultText}.`,
      correctAnswer: resultText,
      interactiveApp: app
    };
  } else if (appType === "network-graph") {
    const nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
    base = {
      question: "How many nodes are in the network graph?",
      solution: `There are ${nodes.length} nodes shown.`,
      correctAnswer: String(nodes.length),
      interactiveApp: app
    };
  } else if (appType === "matrix") {
    const matrixA = Array.isArray(cfg.matrixA) ? cfg.matrixA : [];
    const rows = matrixA.length;
    const cols = rows > 0 && Array.isArray(matrixA[0]) ? matrixA[0].length : 0;
    base = {
      question: "What are the dimensions of Matrix A?",
      solution: `Matrix A has ${rows} row(s) and ${cols} column(s), so dimensions are ${rows} x ${cols}.`,
      correctAnswer: `${rows} x ${cols}`,
      interactiveApp: app
    };
  } else if (appType === "stem-and-leaf") {
    const values = Array.isArray(cfg.values) ? cfg.values : [];
    base = {
      question: "How many values are represented in the stem-and-leaf plot?",
      solution: `The dataset contains ${values.length} values.`,
      correctAnswer: String(values.length),
      interactiveApp: app
    };
  } else if (appType === "geometry-shapes") {
    const shapes = Array.isArray(cfg.shapes) ? cfg.shapes : [];
    base = {
      question: "How many shapes are shown in the geometry diagram?",
      solution: `There are ${shapes.length} shape(s) configured.`,
      correctAnswer: String(shapes.length),
      interactiveApp: app
    };
  } else if (appType === "pythagoras") {
    const a = Number.parseFloat(cfg.sideA);
    const b = Number.parseFloat(cfg.sideB);
    const c = Number.parseFloat(cfg.sideC);
    let answer = "";
    let explanation = "";
    if (Number.isFinite(a) && Number.isFinite(b) && !Number.isFinite(c)) {
      const hyp = roundTo(Math.sqrt(a * a + b * b), 2);
      answer = String(hyp);
      explanation = `c = sqrt(${a}^2 + ${b}^2) = ${hyp}.`;
    } else if (Number.isFinite(a) && Number.isFinite(c) && !Number.isFinite(b)) {
      const side = roundTo(Math.sqrt(Math.max(0, c * c - a * a)), 2);
      answer = String(side);
      explanation = `b = sqrt(${c}^2 - ${a}^2) = ${side}.`;
    } else {
      answer = String(cfg.sideC || "5");
      explanation = `Use the configured sides to identify the missing value ${answer}.`;
    }
    base = {
      question: "Using Pythagoras' theorem, find the missing side length.",
      solution: explanation,
      correctAnswer: answer,
      interactiveApp: app
    };
  } else if (appType === "trigonometry") {
    const focus = String(cfg.focusFunction || "sin").trim().toLowerCase();
    const opp = Number.parseFloat(cfg.opposite);
    const adj = Number.parseFloat(cfg.adjacent);
    const hyp = Number.parseFloat(cfg.hypotenuse);
    let value = Number.NaN;
    if (focus === "sin" && Number.isFinite(opp) && Number.isFinite(hyp) && hyp !== 0) value = opp / hyp;
    if (focus === "cos" && Number.isFinite(adj) && Number.isFinite(hyp) && hyp !== 0) value = adj / hyp;
    if (focus === "tan" && Number.isFinite(opp) && Number.isFinite(adj) && adj !== 0) value = opp / adj;
    const answer = Number.isFinite(value) ? String(roundTo(value, 3)) : "not defined";
    base = {
      question: `What is the value of ${focus}(angle) for the triangle shown?`,
      solution: `Using the side ratio for ${focus}, the value is ${answer}.`,
      correctAnswer: answer,
      interactiveApp: app
    };
  } else {
    base = {
      question: `Use the ${appType} interactive app and determine the key result shown.`,
      solution: "Read the values from the interactive configuration and state the required result.",
      correctAnswer: "See app",
      interactiveApp: app
    };
  }

  return postProcessAutoPayload(
    asResultTypePayload(
      {
        ...base,
        _generation: {
          answerPolicy: generationOptions.answerPolicy || "auto",
          decimalPlaces: generationOptions.decimalPlaces
        }
      },
      defaultResult
    ),
    generationOptions
  );
}

function getSelectOptionLabel(selectId) {
  const select = document.getElementById(selectId);
  if (!(select instanceof HTMLSelectElement)) return "";
  const option = select.options[select.selectedIndex];
  return option ? String(option.textContent || "").trim() : "";
}

function normalizeAutoQuizQuestionCount(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return 10;
  return Math.max(1, Math.min(60, parsed));
}

function resolveAutoQuizYear(gradeValue, yearValue) {
  const year = String(yearValue || "auto").trim().toLowerCase();
  if (year !== "auto") {
    return year === "prep" ? "Prep" : `Year ${year}`;
  }

  const grade = String(gradeValue || "").trim().toLowerCase();
  if (grade === "prep") return "Prep";
  const yearMatch = grade.match(/^year-(\d+)$/);
  if (yearMatch) {
    return `Year ${yearMatch[1]}`;
  }
  return "";
}

function buildAutoQuizTemplatePool(gradeValue, yearValue = "auto") {
  const prepPool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" }
  ];

  const yearOnePool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-addition-v", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "easy", resultType: "multiple-choice" }
  ];

  const lowerPrimaryPool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-multiplication", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "easy", resultType: "multiple-choice" }
  ];

  const primaryPool = [
    { category: "arithmetic", subcategory: "basic-addition-h", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-subtraction", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "basic-multiplication", difficulty: "easy", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "division-short", difficulty: "easy", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "easy", resultType: "short-answer" },
    { category: "number-line", subcategory: "distance", difficulty: "easy", resultType: "short-answer" }
  ];

  const middlePool = [
    { category: "arithmetic", subcategory: "basic-multiplication", difficulty: "medium", resultType: "short-answer" },
    { category: "arithmetic", subcategory: "division-long", difficulty: "medium", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "medium", resultType: "short-answer" },
    { category: "cartesian-plane", subcategory: "point-on-axes", difficulty: "easy", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "quadrant-identification", difficulty: "medium", resultType: "multiple-choice" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "easy", resultType: "multiple-choice" },
    { category: "histogram", subcategory: "count-values", difficulty: "easy", resultType: "short-answer" }
  ];

  const seniorPool = [
    { category: "cartesian-plane", subcategory: "linear", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "gradient", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "intercepts", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "domain-range", difficulty: "medium", resultType: "short-answer" },
    { category: "cartesian-plane-plot", subcategory: "linear", difficulty: "medium", resultType: "plot" },
    { category: "trigonometry", subcategory: "focus-function", difficulty: "medium", resultType: "short-answer" },
    { category: "probability-tree", subcategory: "path-sum", difficulty: "medium", resultType: "short-answer" }
  ];

  const methodsPool = [
    { category: "cartesian-plane", subcategory: "quadratic", difficulty: "medium", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "transformations", difficulty: "hard", resultType: "short-answer" },
    { category: "cartesian-plane", subcategory: "gradient", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "intercepts", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane-plot", subcategory: "quadratic", difficulty: "hard", resultType: "plot" },
    { category: "cartesian-plane-plot", subcategory: "transformations", difficulty: "hard", resultType: "plot" },
    { category: "trigonometry", subcategory: "focus-function", difficulty: "hard", resultType: "short-answer" }
  ];

  const generalPool = [
    { category: "arithmetic", subcategory: "division-long", difficulty: "medium", resultType: "short-answer" },
    { category: "fractions", subcategory: "operation-result", difficulty: "medium", resultType: "short-answer" },
    { category: "bar-chart", subcategory: "highest-category", difficulty: "medium", resultType: "multiple-choice" },
    { category: "histogram", subcategory: "count-values", difficulty: "medium", resultType: "short-answer" },
    { category: "box-plot", subcategory: "median", difficulty: "medium", resultType: "short-answer" },
    { category: "scatter-plot", subcategory: "correlation-sign", difficulty: "medium", resultType: "multiple-choice" },
    { category: "probability-tree", subcategory: "path-sum", difficulty: "medium", resultType: "short-answer" }
  ];

  const specialistPool = [
    { category: "cartesian-plane", subcategory: "cubic", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane", subcategory: "asymptotes", difficulty: "hard", resultType: "multiple-choice" },
    { category: "cartesian-plane-plot", subcategory: "cubic", difficulty: "hard", resultType: "plot" },
    { category: "cartesian-plane-plot", subcategory: "asymptotes", difficulty: "hard", resultType: "plot" },
    { category: "matrix", subcategory: "matrix-a-dim", difficulty: "hard", resultType: "short-answer" },
    { category: "network-graph", subcategory: "node-count", difficulty: "medium", resultType: "short-answer" },
    { category: "trigonometry", subcategory: "focus-function", difficulty: "hard", resultType: "short-answer" }
  ];

  const yearLevel = deriveYearLevelFromGenerationOptions({ gradeValue, yearValue });
  if (yearLevel === 0) {
    return prepPool;
  }
  if (yearLevel === 1) {
    return yearOnePool;
  }
  if (yearLevel === 2) {
    return lowerPrimaryPool;
  }
  if (Number.isInteger(yearLevel) && yearLevel >= 3 && yearLevel <= 6) {
    return primaryPool;
  }
  if (Number.isInteger(yearLevel) && yearLevel >= 7 && yearLevel <= 8) {
    return middlePool;
  }
  if (Number.isInteger(yearLevel) && yearLevel >= 9 && yearLevel <= 10) {
    return seniorPool;
  }

  const grade = String(gradeValue || "").trim().toLowerCase();
  if (grade.startsWith("vce-methods-")) {
    return methodsPool;
  }
  if (grade.startsWith("vce-general-")) {
    return generalPool;
  }
  if (grade.startsWith("vce-specialist-")) {
    return specialistPool;
  }
  return middlePool;
}

function resolveAutoQuizDifficultyFromYear(gradeValue, yearValue) {
  const yearLevel = deriveYearLevelFromGenerationOptions({ gradeValue, yearValue });
  if (yearLevel === null) {
    const grade = String(gradeValue || "").trim().toLowerCase();
    if (grade.startsWith("vce-")) {
      return "hard";
    }
    return "medium";
  }

  if (yearLevel <= 2) return "easy";
  if (yearLevel <= 8) return "medium";
  return "hard";
}

function buildAutoQuizQuestion(questionTemplate, index, generationOptions) {
  const commandWordChoice = normalizeCommandWordChoice(generationOptions && generationOptions.commandWord);
  const nextCommandWord = pickCommandWordFromChoice(commandWordChoice, {
    resultType: questionTemplate && questionTemplate.resultType,
    index
  });
  const difficultyOverride = String(generationOptions && generationOptions.yearDifficulty || "").trim().toLowerCase();
  const normalizedOverride = ["easy", "medium", "hard"].includes(difficultyOverride) ? difficultyOverride : "";
  const nextDifficulty = normalizedOverride || (questionTemplate && questionTemplate.difficulty) || "medium";
  const options = {
    ...generationOptions,
    commandWord: nextCommandWord,
    category: questionTemplate && questionTemplate.category ? questionTemplate.category : "",
    questionIndex: index
  };
  return buildAutoPayloadForCategory(
    questionTemplate.category,
    questionTemplate.subcategory,
    nextDifficulty,
    questionTemplate.resultType,
    options
  );
}

async function autoCreateEntireQuiz(quizId = state.selectedQuizId) {
  const category = activeCategory();
  if (!category) {
    showToast("Select a category first.", "warning");
    return;
  }

  if (quizId && state.selectedQuizId !== quizId) {
    state.selectedQuizId = quizId;
  }

  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Select a quiz first.", "warning");
    return;
  }

  const existingQuestions = Array.isArray(quiz.questions) ? quiz.questions : [];
  const existingCount = existingQuestions.length;

  const gradeSelect = document.getElementById("autoQuizGrade");
  const yearSelect = document.getElementById("autoQuizYear");
  const countInput = document.getElementById("autoQuizQuestionCount");
  const selectedCategory = String(document.getElementById("autoCreateCategory").value || "").trim();
  const selectedSubcategory = String(document.getElementById("autoCreateSubcategory").value || "").trim();
  const selectedResultType = String(document.getElementById("autoCreateResultType").value || "auto").trim();
  const selectedCommandWord = String(document.getElementById("autoCreateCommandWord").value || "determine").trim();
  const answerPolicy = String(document.getElementById("autoCreateAnswerFormat").value || "auto").trim();
  const decimalPlaces = Number.parseInt(document.getElementById("autoCreateDecimalPlaces").value, 10);

  const gradeValue = gradeSelect instanceof HTMLSelectElement ? String(gradeSelect.value || "year-7") : "year-7";
  const gradeLabel = getSelectOptionLabel("autoQuizGrade") || "VCAA Mathematics";
  const yearValue = yearSelect instanceof HTMLSelectElement ? String(yearSelect.value || "auto") : "auto";
  const yearLabel = resolveAutoQuizYear(gradeValue, yearValue);
  const yearDifficulty = resolveAutoQuizDifficultyFromYear(gradeValue, yearValue);
  const questionCount = normalizeAutoQuizQuestionCount(countInput instanceof HTMLInputElement ? countInput.value : 10);
  if (countInput instanceof HTMLInputElement) {
    countInput.value = String(questionCount);
  }

  const generationOptions = {
    commandWord: selectedCommandWord || "determine",
    answerPolicy,
    decimalPlaces: Number.isInteger(decimalPlaces) ? decimalPlaces : 2,
    gradeValue,
    yearValue,
    yearDifficulty,
    domainMin: null,
    domainMax: null
  };

  const focusedTemplate = selectedCategory && selectedSubcategory
    ? [{
      category: selectedCategory,
      subcategory: selectedSubcategory,
      difficulty: yearDifficulty,
      resultType: selectedResultType || "auto"
    }]
    : null;

  const templatePool = Array.isArray(focusedTemplate) && focusedTemplate.length > 0
    ? focusedTemplate
    : buildAutoQuizTemplatePool(gradeValue, yearValue);
  if (!Array.isArray(templatePool) || templatePool.length === 0) {
    showToast("No templates available for that grade/course.", "warning");
    return;
  }

  const generatedQuestions = [];
  const failureMessages = [];
  const maxAttempts = questionCount * 8;
  let attempts = 0;
  let cursor = 0;

  while (generatedQuestions.length < questionCount && attempts < maxAttempts) {
    const template = templatePool[cursor % templatePool.length];
    const payload = buildAutoQuizQuestion(template, generatedQuestions.length, generationOptions);
    attempts += 1;
    cursor += 1;

    if (!payload) {
      failureMessages.push(`${template.category}/${template.subcategory}: no payload generated`);
      continue;
    }

    const verification = verifyAutoPayload(template.category, template.subcategory, payload);
    if (!verification.ok) {
      failureMessages.push(`${template.category}/${template.subcategory}: ${verification.issues[0] || "verification failed"}`);
      continue;
    }

    generatedQuestions.push(normalizeQuestion({
      question: payload.question || "",
      resultType: payload.resultType || "short-answer",
      options: Array.isArray(payload.options) ? payload.options : ["", "", "", ""],
      correctAnswer: payload.correctAnswer || "",
      notesAttachments: [],
      image: "",
      solution: payload.solution || "",
      solutionAttachments: [],
      interactiveApp: payload.interactiveApp || null
    }));
  }

  if (generatedQuestions.length === 0) {
    const firstFailure = failureMessages[0] || "No valid questions generated.";
    showToast(`Auto quiz generation failed: ${firstFailure}`, "error");
    return;
  }

  quiz.questions = existingQuestions.concat(generatedQuestions);
  if (!String(quiz.title || "").trim()) {
    quiz.title = `${gradeLabel}${yearLabel ? ` ${yearLabel}` : ""} Auto Quiz`;
  }
  quiz.description = `Auto-generated quiz aligned to VCAA style for ${gradeLabel}${yearLabel ? ` (${yearLabel})` : ""}.`;
  quiz.settings = normalizeQuizSettings({
    questionOrder: "ordered",
    questionLimit: quiz.questions.length
  });

  state.selectedQuestionIndex = existingCount;
  renderAll();
  await persistSelectedQuizAfterMutation("Auto-generated questions");

  if (generatedQuestions.length < questionCount) {
    showToast(`Added ${generatedQuestions.length}/${questionCount} questions. Some templates failed verification.`, "warning");
    return;
  }

  showToast(`Added ${generatedQuestions.length} VCAA-aligned questions.`, "success");
}

function buildAutoCreatedQuestionPayload(subcategory, difficulty, resultTypeChoice = "auto") {
  const normalizedSubcategory = String(subcategory || "linear").trim().toLowerCase();
  const normalizedDifficulty = String(difficulty || "easy").trim().toLowerCase();
  const normalizedResultType = String(resultTypeChoice || "auto").trim().toLowerCase();
  const isPlotSubcategory = ["linear", "quadratic", "cubic", "exponential", "transformations"].includes(normalizedSubcategory);
  const desiredResultType = normalizedResultType === "auto"
    ? (isPlotSubcategory ? "plot" : "multiple-choice")
    : normalizedResultType;

  if (desiredResultType === "plot" || desiredResultType === "short-answer") {
    return buildAutoCartesianPlotPayload(normalizedSubcategory, normalizedDifficulty);
  }
  if (desiredResultType === "true-false") {
    return buildAutoCartesianTrueFalsePayload(normalizedSubcategory, normalizedDifficulty);
  }
  return buildAutoCartesianMcqPayload(normalizedSubcategory, normalizedDifficulty);
}

function applyAutoCreatedQuestionToEditor(payload) {
  if (!payload) return;
  document.getElementById("questionText").value = payload.question || "";
  document.getElementById("resultType").value = payload.resultType || "short-answer";
  document.getElementById("option1").value = payload.options && payload.options[0] ? payload.options[0] : "";
  document.getElementById("option2").value = payload.options && payload.options[1] ? payload.options[1] : "";
  document.getElementById("option3").value = payload.options && payload.options[2] ? payload.options[2] : "";
  document.getElementById("option4").value = payload.options && payload.options[3] ? payload.options[3] : "";
  document.getElementById("correctAnswer").value = payload.correctAnswer || "";
  document.getElementById("solutionText").value = payload.solution || "";

  refreshCorrectAnswerSelect({
    resultType: payload.resultType || "short-answer",
    options: payload.options || ["", "", "", ""],
    correctAnswer: payload.correctAnswer || "",
    interactiveApp: payload.interactiveApp || null
  });

  const select = document.getElementById("correctAnswerSelect");
  if ((payload.resultType === "multiple-choice" || payload.resultType === "true-false") && select) {
    const choiceOptions = (payload.options || []).map((item) => String(item || "").trim()).filter((item) => item !== "");
    const answerIndex = choiceOptions.findIndex((item) => normalizeText(item) === normalizeText(payload.correctAnswer || ""));
    select.value = answerIndex >= 0 ? String(answerIndex) : "";
  }

  const app = payload.interactiveApp || null;
  const typeSelect = document.getElementById("interactiveAppType");
  typeSelect.value = app && app.type ? app.type : "";
  if (app) {
    populateInteractiveAppForm(app);
  } else {
    setInteractiveAppConfigVisibility("");
    renderInteractiveAppPreview(null);
  }
}

function defaultBoxPlotDatasetLabel(index) {
  const offset = Number(index);
  if (Number.isInteger(offset) && offset >= 0 && offset < 26) {
    return String.fromCharCode(65 + offset);
  }
  return `Dataset ${Number.isInteger(offset) ? offset + 1 : 1}`;
}

function clampBoxPlotDatasetCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count)) return 2;
  return Math.max(1, Math.min(8, count));
}

function normalizeBoxPlotDatasets(config) {
  const fromArray = Array.isArray(config && config.datasets) ? config.datasets : [];
  const normalizedFromArray = fromArray.map((item, index) => ({
    label: String(item && item.label ? item.label : "").trim() || defaultBoxPlotDatasetLabel(index),
    values: (Array.isArray(item && item.values) ? item.values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  }));

  if (normalizedFromArray.length > 0) {
    return normalizedFromArray;
  }

  return [
    {
      label: String((config && config.labelA) || "").trim() || "A",
      values: (Array.isArray(config && config.valuesA) ? config.valuesA : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    },
    {
      label: String((config && config.labelB) || "").trim() || "B",
      values: (Array.isArray(config && config.valuesB) ? config.valuesB : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    }
  ];
}

function parseBoxPlotDatasetsFromText(text, datasetCount) {
  const count = clampBoxPlotDatasetCount(datasetCount);
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim());
  const datasets = [];

  for (let index = 0; index < count; index += 1) {
    const line = lines[index] || "";
    const delimiterIndex = line.indexOf(":");
    const hasDelimiter = delimiterIndex >= 0;
    const rawLabel = hasDelimiter ? line.slice(0, delimiterIndex).trim() : "";
    const rawValues = hasDelimiter ? line.slice(delimiterIndex + 1) : line;
    datasets.push({
      label: rawLabel || defaultBoxPlotDatasetLabel(index),
      values: parseNumericList(rawValues)
    });
  }

  return datasets;
}

function serializeBoxPlotDatasets(datasets) {
  if (!Array.isArray(datasets)) return "";
  return datasets
    .map((item, index) => {
      const label = String(item && item.label ? item.label : "").trim() || defaultBoxPlotDatasetLabel(index);
      const values = Array.isArray(item && item.values) ? item.values : [];
      return `${label}: ${values.join(", ")}`;
    })
    .join("\n");
}

function parseBarChartItems(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      const category = String(parts[0] || "").trim();
      const frequency = Number.parseFloat(parts[1]);
      if (!category || !Number.isFinite(frequency)) return null;
      return {
        category,
        frequency: Math.max(0, frequency),
        color: parts[2] || "#2563eb"
      };
    })
    .filter(Boolean);
}

function parseProbabilityTreePaths(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 2) return null;
      const path = String(parts[0] || "").split(">").map((item) => item.trim()).filter((item) => item !== "");
      const probability = Number.parseFloat(parts[1]);
      if (path.length === 0 || !Number.isFinite(probability)) return null;
      return { path, probability: Math.max(0, probability) };
    })
    .filter(Boolean);
}

function parseNetworkNodes(text) {
  return String(text || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function parseNetworkEdges(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 3) return null;
      const from = String(parts[0] || "").trim();
      const to = String(parts[1] || "").trim();
      const weight = Number.parseFloat(parts[2]);
      const capacity = Number.parseFloat(parts[3]);
      if (!from || !to || !Number.isFinite(weight)) return null;
      return {
        from,
        to,
        weight,
        capacity: Number.isFinite(capacity) ? Math.max(0, capacity) : Math.max(0, weight)
      };
    })
    .filter(Boolean);
}

function parseMatrixRows(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const values = line
        .replace(/,/g, " ")
        .split(/\s+/)
        .map((item) => Number.parseFloat(item));
      if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
        return null;
      }
      return values;
    })
    .filter(Boolean);
}

function normalizeGeometryShapeType(value) {
  const kind = String(value || "").trim().toLowerCase();
  if (["rectangle", "square", "circle", "triangle", "cube", "cuboid", "sphere", "cylinder"].includes(kind)) return kind;
  return "rectangle";
}

function parseGeometryShapes(text) {
  return parseLineList(text)
    .map((line) => {
      const parts = splitCsvLine(line);
      if (parts.length < 5) return null;
      const type = normalizeGeometryShapeType(parts[0]);
      const x = Number.parseFloat(parts[1]);
      const y = Number.parseFloat(parts[2]);
      const w = Number.parseFloat(parts[3]);
      const h = Number.parseFloat(parts[4]);
      const usesExtendedFormat = parts.length >= 9;
      const d = usesExtendedFormat ? Number.parseFloat(parts[5]) : Number.NaN;
      const labelIndex = usesExtendedFormat ? 6 : 5;
      const colorIndex = usesExtendedFormat ? 7 : 6;
      const fillIndex = usesExtendedFormat ? 8 : 7;
      if (![x, y, w].every(Number.isFinite)) return null;
      return {
        type,
        x,
        y,
        w,
        h: Number.isFinite(h) ? h : w,
        d: Number.isFinite(d) ? d : 0,
        label: parts[labelIndex] || "",
        color: parts[colorIndex] || "#2563eb",
        fill: parts[fillIndex] || "#dbeafe"
      };
    })
    .filter(Boolean);
}

function serializeNlPoints(points) {
  if (!Array.isArray(points)) return "";
  return points.map((point) => `${point.value}, ${point.label || ""}, ${point.color || "#2563eb"}`).join("\n");
}

function serializeNlArrows(arrows) {
  if (!Array.isArray(arrows)) return "";
  return arrows.map((arrow) => `${arrow.from} → ${arrow.to}${arrow.label ? `, ${arrow.label}` : ""}`).join("\n");
}

function serializeCartesianPoints(points) {
  if (!Array.isArray(points)) return "";
  return points.map((point) => `${point.x}, ${point.y}, ${point.label || ""}, ${point.color || "#2563eb"}`).join("\n");
}

function serializeCartesianSegments(segments) {
  if (!Array.isArray(segments)) return "";
  return segments.map((segment) => `${segment.x1}, ${segment.y1} → ${segment.x2}, ${segment.y2}${segment.label ? `, ${segment.label}` : ""}${segment.color ? `, ${segment.color}` : ""}`).join("\n");
}

function serializeCartesianParabolas(parabolas) {
  if (!Array.isArray(parabolas)) return "";
  return parabolas
    .map((item) => `${item.a}, ${item.b}, ${item.c}${item.label ? `, ${item.label}` : ""}${item.color ? `, ${item.color}` : ""}`)
    .join("\n");
}

function serializeCartesianFunctions(functionsList) {
  if (!Array.isArray(functionsList)) return "";
  return functionsList
    .map((item) => `${item.expression || ""}${item.label ? `, ${item.label}` : ""}${item.color ? `, ${item.color}` : ""}`)
    .join("\n");
}

function serializeGeometryShapes(shapes) {
  if (!Array.isArray(shapes)) return "";
  return shapes
    .map((shape) => `${shape.type || "rectangle"}, ${shape.x}, ${shape.y}, ${shape.w}, ${shape.h}, ${shape.d || 0}, ${shape.label || ""}, ${shape.color || "#2563eb"}, ${shape.fill || "#dbeafe"}`)
    .join("\n");
}

function serializeBarChartItems(items) {
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => `${item.category || ""}, ${item.frequency ?? ""}${item.color ? `, ${item.color}` : ""}`)
    .join("\n");
}

function serializeProbabilityTreePaths(paths) {
  if (!Array.isArray(paths)) return "";
  return paths
    .map((item) => `${Array.isArray(item.path) ? item.path.join(">") : ""}, ${item.probability ?? ""}`)
    .join("\n");
}

function serializeNetworkEdges(edges) {
  if (!Array.isArray(edges)) return "";
  return edges
    .map((edge) => `${edge.from || ""}, ${edge.to || ""}, ${edge.weight ?? ""}, ${edge.capacity ?? ""}`)
    .join("\n");
}

function serializeMatrixRows(rows) {
  if (!Array.isArray(rows)) return "";
  return rows
    .filter((row) => Array.isArray(row) && row.length > 0)
    .map((row) => row.map((value) => Number(value)).filter((value) => Number.isFinite(value)).join(", "))
    .join("\n");
}

function buildDefaultInteractiveApp(type) {
  switch (type) {
    case "number-line":
      return {
        type,
        config: {
          min: -10,
          max: 10,
          points: [{ value: -3, label: "A", color: "#dc2626" }, { value: 5, label: "B", color: "#2563eb" }],
          arrows: [{ from: -3, to: 5, label: "+8" }]
        }
      };
    case "cartesian-plane":
      return {
        type,
        config: {
          xMin: -10,
          xMax: 10,
          yMin: -10,
          yMax: 10,
          angleMode: "radians",
          points: [{ x: 3, y: -2, label: "P", color: "#2563eb" }],
          segments: [{ x1: 0, y1: 0, x2: 4, y2: 3, label: "segment", color: "#f59e0b" }],
          parabolas: [{ a: 1, b: 0, c: 0, label: "y = x^2", color: "#7c3aed" }],
          functions: [{ expression: "sin(x)", label: "y = sin(x)", color: "#0f766e" }]
        }
      };
    case "cartesian-plane-plot":
      return {
        type,
        config: {
          xMin: -10,
          xMax: 10,
          yMin: -10,
          yMax: 10,
          tolerance: 0.5,
          points: [{ x: 3, y: 4, label: "A" }, { x: -2, y: -3, label: "B" }],
          vceTemplate: "",
          presetType: "linear",
          presetExpression: "2*x + 1",
          presetXValues: "-2, -1, 0, 1, 2"
        }
      };
    case "bar-chart":
      return {
        type,
        config: {
          title: "Category Frequencies",
          yMax: null,
          orientation: "vertical",
          categoryAxisLabel: "Category",
          valueAxisLabel: "Value",
          items: [
            { category: "Cats", frequency: 8, color: "#2563eb" },
            { category: "Dogs", frequency: 12, color: "#16a34a" },
            { category: "Birds", frequency: 5, color: "#f59e0b" }
          ]
        }
      };
    case "histogram":
      return {
        type,
        config: {
          title: "Continuous Data Distribution",
          values: [12, 13, 14, 16, 18, 22, 25, 27, 29, 33],
          binCount: 8
        }
      };
    case "box-plot":
      return {
        type,
        config: {
          title: "Compare Datasets",
          datasets: [
            { label: "A", values: [8, 9, 10, 12, 14, 17, 20] },
            { label: "B", values: [6, 8, 11, 12, 13, 14, 18] }
          ]
        }
      };
    case "scatter-plot":
      return {
        type,
        config: {
          title: "Correlation and Best Fit",
          points: [
            { x: 1, y: 2, label: "P1", color: "#2563eb" },
            { x: 2, y: 3, label: "P2", color: "#2563eb" },
            { x: 3, y: 5, label: "P3", color: "#2563eb" },
            { x: 4, y: 7, label: "P4", color: "#2563eb" }
          ]
        }
      };
    case "probability-tree":
      return {
        type,
        config: {
          title: "Sequential Probabilities",
          paths: [
            { path: ["Rain", "Traffic"], probability: 0.3 },
            { path: ["Rain", "NoTraffic"], probability: 0.1 },
            { path: ["NoRain", "Traffic"], probability: 0.2 },
            { path: ["NoRain", "NoTraffic"], probability: 0.4 }
          ],
          conditionalQuery: "Traffic|Rain"
        }
      };
    case "distribution-curve":
      return {
        type,
        config: {
          title: "Normal Distribution",
          mean: 0,
          stdDev: 1,
          from: -1,
          to: 1
        }
      };
    case "fractions":
      return {
        type,
        config: {
          title: "Fraction Operations",
          operation: "add",
          fractionA: { numerator: 1, denominator: 2 },
          fractionB: { numerator: 1, denominator: 3 }
        }
      };
    case "network-graph":
      return {
        type,
        config: {
          title: "Shortest Path, MST, Flow",
          nodes: ["A", "B", "C", "D", "E"],
          edges: [
            { from: "A", to: "B", weight: 4, capacity: 8 },
            { from: "A", to: "C", weight: 2, capacity: 5 },
            { from: "B", to: "D", weight: 3, capacity: 6 },
            { from: "C", to: "D", weight: 1, capacity: 4 },
            { from: "D", to: "E", weight: 2, capacity: 7 }
          ],
          source: "A",
          target: "E",
          flowSource: "A",
          flowSink: "E"
        }
      };
    case "matrix":
      return {
        type,
        config: {
          title: "Matrix Operations",
          operation: "multiply",
          matrixA: [[1, 2, 3], [4, 5, 6]],
          matrixB: [[7, 8], [9, 10], [11, 12]]
        }
      };
    case "stem-and-leaf":
      return {
        type,
        config: {
          values: [12, 13, 17, 21, 25, 29, 32],
          stemUnit: 10
        }
      };
    case "geometry-shapes":
      return {
        type,
        config: {
          canvasWidth: 360,
          canvasHeight: 260,
          unit: "unit",
          formulaNotation: "plain",
          shapes: [
            { type: "rectangle", x: 90, y: 80, w: 90, h: 60, d: 0, label: "Rect A", color: "#2563eb", fill: "#dbeafe" },
            { type: "circle", x: 240, y: 80, w: 35, h: 35, d: 0, label: "Circle B", color: "#16a34a", fill: "#dcfce7" },
            { type: "cube", x: 170, y: 190, w: 70, h: 70, d: 70, label: "Cube C", color: "#dc2626", fill: "#fee2e2" }
          ]
        }
      };
    case "pythagoras":
      return {
        type,
        config: {
          sideA: "3",
          sideB: "4",
          sideC: "5",
          caption: "Use a² + b² = c²"
        }
      };
    case "trigonometry":
      return {
        type,
        config: {
          angleDeg: 35,
          focusFunction: "sin",
          opposite: "7",
          adjacent: "10",
          hypotenuse: "12.2"
        }
      };
    default:
      return null;
  }
}

function buildNumberLineMarkup(config) {
  const min = Number(config.min ?? -10);
  const max = Number(config.max ?? 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return "<p class='helper-text'>Invalid range: min must be less than max.</p>";
  }

  const points = Array.isArray(config.points) ? config.points : [];
  const arrows = Array.isArray(config.arrows) ? config.arrows : [];
  const svgW = 600;
  const svgH = 130;
  const padX = 50;
  const lineY = 75;
  const tickH = 10;
  const usable = svgW - padX * 2;
  const xPos = (val) => padX + ((val - min) / (max - min)) * usable;
  const parts = [];
  parts.push('<defs><marker id="nl-arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#f59e0b"/></marker></defs>');
  parts.push(`<line x1="${padX - 12}" y1="${lineY}" x2="${svgW - padX + 12}" y2="${lineY}" stroke="#334155" stroke-width="2"/>`);
  parts.push(`<polygon points="${padX - 22},${lineY} ${padX - 12},${lineY - 5} ${padX - 12},${lineY + 5}" fill="#334155"/>`);
  parts.push(`<polygon points="${svgW - padX + 22},${lineY} ${svgW - padX + 12},${lineY - 5} ${svgW - padX + 12},${lineY + 5}" fill="#334155"/>`);

  const range = max - min;
  let step = 1;
  if (range > 40) step = 5;
  else if (range > 20) step = 2;

  for (let i = min; i <= max; i += step) {
    const x = xPos(i);
    const isZero = i === 0;
    parts.push(`<line x1="${x}" y1="${lineY - tickH}" x2="${x}" y2="${lineY + tickH}" stroke="#334155" stroke-width="${isZero ? 2 : 1}"/>`);
    parts.push(`<text x="${x}" y="${lineY + 26}" text-anchor="middle" font-size="12" fill="${isZero ? "#1e293b" : "#64748b"}" font-weight="${isZero ? "bold" : "normal"}">${i}</text>`);
  }

  arrows.forEach((arrow) => {
    const fx = xPos(Number(arrow.from));
    const tx = xPos(Number(arrow.to));
    if (![fx, tx].every(Number.isFinite)) return;
    const mx = (fx + tx) / 2;
    const peak = lineY - 38;
    const label = escapeInteractiveHtml(String(arrow.label || ""));
    parts.push(`<path d="M ${fx} ${lineY - 10} Q ${mx} ${peak} ${tx} ${lineY - 10}" stroke="#f59e0b" stroke-width="2" fill="none" marker-end="url(#nl-arr)"/>`);
    if (label) parts.push(`<text x="${mx}" y="${peak - 6}" text-anchor="middle" font-size="12" fill="#b45309" font-weight="bold">${label}</text>`);
  });

  points.forEach((point) => {
    const x = xPos(Number(point.value));
    if (!Number.isFinite(x)) return;
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeInteractiveHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${lineY}" r="8" fill="${color}" stroke="white" stroke-width="2"/>`);
    if (label) parts.push(`<text x="${x}" y="${lineY - 16}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
  });

  return `<div class="nl-container"><svg viewBox="0 0 ${svgW} ${svgH}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildCartesianPlaneMarkup(config) {
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) {
    return "<p class='helper-text'>Invalid plane range.</p>";
  }

  const points = Array.isArray(config.points) ? config.points : [];
  const segments = Array.isArray(config.segments) ? config.segments : [];
  const parabolas = Array.isArray(config.parabolas) ? config.parabolas : [];
  const functionsList = Array.isArray(config.functions) ? config.functions : [];
  const size = 320;
  const pad = 36;
  const usable = size - pad * 2;
  const xPos = (x) => pad + ((x - xMin) / (xMax - xMin)) * usable;
  const yPos = (y) => size - pad - ((y - yMin) / (yMax - yMin)) * usable;
  const axisX = xMin <= 0 && xMax >= 0 ? xPos(0) : null;
  const axisY = yMin <= 0 && yMax >= 0 ? yPos(0) : null;
  const parts = [];
  const xRange = xMax - xMin;
  const yRange = yMax - yMin;
  let xStep = 1;
  let yStep = 1;
  if (xRange > 20) xStep = xRange > 40 ? 5 : 2;
  if (yRange > 20) yStep = yRange > 40 ? 5 : 2;

  for (let x = xMin; x <= xMax; x += xStep) {
    const xCoord = xPos(x);
    parts.push(`<line x1="${xCoord}" y1="${pad}" x2="${xCoord}" y2="${size - pad}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${xCoord}" y="${size - pad + 18}" text-anchor="middle" font-size="11" fill="#64748b">${x}</text>`);
  }
  for (let y = yMin; y <= yMax; y += yStep) {
    const yCoord = yPos(y);
    parts.push(`<line x1="${pad}" y1="${yCoord}" x2="${size - pad}" y2="${yCoord}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${pad - 10}" y="${yCoord + 4}" text-anchor="end" font-size="11" fill="#64748b">${y}</text>`);
  }

  if (axisX !== null) {
    parts.push(`<line x1="${axisX}" y1="${pad - 6}" x2="${axisX}" y2="${size - pad + 6}" stroke="#334155" stroke-width="2"/>`);
  }
  if (axisY !== null) {
    parts.push(`<line x1="${pad - 6}" y1="${axisY}" x2="${size - pad + 6}" y2="${axisY}" stroke="#334155" stroke-width="2"/>`);
  }

  segments.forEach((segment) => {
    const x1 = xPos(Number(segment.x1));
    const y1 = yPos(Number(segment.y1));
    const x2 = xPos(Number(segment.x2));
    const y2 = yPos(Number(segment.y2));
    if (![x1, y1, x2, y2].every(Number.isFinite)) return;
    const color = safeInteractiveColor(segment.color, "#f59e0b");
    const label = escapeInteractiveHtml(String(segment.label || ""));
    parts.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`);
    if (label) {
      parts.push(`<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
    }
  });

  parabolas.forEach((curve) => {
    const a = Number(curve.a);
    const b = Number(curve.b);
    const c = Number(curve.c);
    if (![a, b, c].every(Number.isFinite)) return;
    const color = safeInteractiveColor(curve.color, "#7c3aed");
    const label = escapeInteractiveHtml(String(curve.label || ""));
    const samples = 80;
    const pointsPath = [];
    for (let i = 0; i <= samples; i += 1) {
      const xValue = xMin + (i / samples) * (xMax - xMin);
      const yValue = a * xValue * xValue + b * xValue + c;
      const sx = xPos(xValue);
      const sy = yPos(yValue);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      pointsPath.push(`${i === 0 ? "M" : "L"} ${sx} ${sy}`);
    }
    if (pointsPath.length > 1) {
      parts.push(`<path d="${pointsPath.join(" ")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/>`);
      if (label) {
        const xAtLabel = (xMin + xMax) / 2;
        const yAtLabel = a * xAtLabel * xAtLabel + b * xAtLabel + c;
        const lx = xPos(xAtLabel);
        const ly = yPos(yAtLabel);
        if (Number.isFinite(lx) && Number.isFinite(ly)) {
          parts.push(`<text x="${lx + 8}" y="${ly - 8}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
        }
      }
    }
  });

  functionsList.forEach((curve) => {
    const expression = String(curve.expression || "").trim();
    if (!expression) return;
    const evaluate = buildCartesianExpressionEvaluator(expression);
    if (!evaluate) return;
    const color = safeInteractiveColor(curve.color, "#0f766e");
    const label = escapeInteractiveHtml(String(curve.label || `y = ${expression}`));
    const samples = 120;
    const pathParts = [];
    for (let i = 0; i <= samples; i += 1) {
      const xValue = xMin + (i / samples) * (xMax - xMin);
      const yValue = evaluate(xValue);
      const sx = xPos(xValue);
      const sy = yPos(yValue);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      pathParts.push(`${i === 0 ? "M" : "L"} ${sx} ${sy}`);
    }
    if (pathParts.length > 1) {
      parts.push(`<path d="${pathParts.join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="6 3"/>`);
      const xAtLabel = xMin + 0.75 * (xMax - xMin);
      const yAtLabel = evaluate(xAtLabel);
      const lx = xPos(xAtLabel);
      const ly = yPos(yAtLabel);
      if (Number.isFinite(lx) && Number.isFinite(ly)) {
        parts.push(`<text x="${lx + 8}" y="${ly - 8}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
      }
    }
  });

  points.forEach((point) => {
    const x = xPos(Number(point.x));
    const y = yPos(Number(point.y));
    if (![x, y].every(Number.isFinite)) return;
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeInteractiveHtml(String(point.label || ""));
    parts.push(`<circle cx="${x}" cy="${y}" r="6" fill="${color}" stroke="white" stroke-width="2"/>`);
    if (label) {
      parts.push(`<text x="${x + 10}" y="${y - 10}" font-size="11" fill="${color}" font-weight="bold">${label}</text>`);
    }
  });

  return `<div class="cartesian-container"><svg viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildCartesianPlotMarkup(config) {
  // Preview in the maker: show the grid with the answer points marked.
  const xMin = Number(config.xMin ?? -10);
  const xMax = Number(config.xMax ?? 10);
  const yMin = Number(config.yMin ?? -10);
  const yMax = Number(config.yMax ?? 10);
  if (![xMin, xMax, yMin, yMax].every(Number.isFinite) || xMin >= xMax || yMin >= yMax) return "";
  const points = Array.isArray(config.points) ? config.points : [];
  const size = 320;
  const pad = 36;
  const usable = size - pad * 2;
  const xPos = (x) => pad + ((x - xMin) / (xMax - xMin)) * usable;
  const yPos = (y) => size - pad - ((y - yMin) / (yMax - yMin)) * usable;
  const axisX = xMin <= 0 && xMax >= 0 ? xPos(0) : null;
  const axisY = yMin <= 0 && yMax >= 0 ? yPos(0) : null;
  const parts = [];
  const xRange = xMax - xMin;
  const yRange = yMax - yMin;
  let xStep = 1;
  let yStep = 1;
  if (xRange > 20) xStep = xRange > 40 ? 5 : 2;
  if (yRange > 20) yStep = yRange > 40 ? 5 : 2;
  for (let x = xMin; x <= xMax; x += xStep) {
    const xc = xPos(x);
    parts.push(`<line x1="${xc}" y1="${pad}" x2="${xc}" y2="${size - pad}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${xc}" y="${size - pad + 18}" text-anchor="middle" font-size="11" fill="#64748b">${x}</text>`);
  }
  for (let y = yMin; y <= yMax; y += yStep) {
    const yc = yPos(y);
    parts.push(`<line x1="${pad}" y1="${yc}" x2="${size - pad}" y2="${yc}" stroke="#dbe6f3" stroke-width="1"/>`);
    parts.push(`<text x="${pad - 10}" y="${yc + 4}" text-anchor="end" font-size="11" fill="#64748b">${y}</text>`);
  }
  if (axisX !== null) parts.push(`<line x1="${axisX}" y1="${pad - 6}" x2="${axisX}" y2="${size - pad + 6}" stroke="#334155" stroke-width="2"/>`);
  if (axisY !== null) parts.push(`<line x1="${pad - 6}" y1="${axisY}" x2="${size - pad + 6}" y2="${axisY}" stroke="#334155" stroke-width="2"/>`);
  points.forEach((point) => {
    const x = xPos(Number(point.x));
    const y = yPos(Number(point.y));
    if (![x, y].every(Number.isFinite)) return;
    const label = escapeInteractiveHtml(String(point.label || `(${point.x},${point.y})`));
    parts.push(`<circle cx="${x}" cy="${y}" r="7" fill="#16a34a" stroke="white" stroke-width="2"/>`);
    parts.push(`<text x="${x + 10}" y="${y - 10}" font-size="11" fill="#16a34a" font-weight="bold">${label}</text>`);
  });
  const pointSummary = points.length > 0
    ? points.map((p) => `(${p.x}, ${p.y})${p.label ? " " + p.label : ""}`).join(" · ")
    : "No answer points configured";
  return `<div class="cartesian-container"><svg viewBox="0 0 ${size} ${size}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div><p class="helper-text">Answer points: ${escapeInteractiveHtml(pointSummary)}</p>`;
}

function buildStemLeafMarkup(config) {
  const values = Array.isArray(config.values) ? config.values.slice() : [];
  const stemUnit = Math.max(1, Number.parseInt(config.stemUnit, 10) || 10);
  if (values.length === 0) {
    return "<p class='helper-text'>Add values to build the stem-and-leaf plot.</p>";
  }

  const grouped = new Map();
  values.sort((a, b) => a - b).forEach((value) => {
    const stem = Math.trunc(value / stemUnit);
    const leaf = Math.abs(value - stem * stemUnit);
    if (!grouped.has(stem)) grouped.set(stem, []);
    grouped.get(stem).push(leaf);
  });

  const rows = Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([stem, leaves]) => `<tr><th>${stem}</th><td>${leaves.join(" ")}</td></tr>`)
    .join("");

  return `
    <div class="stem-leaf-container">
      <div class="stem-leaf-key">Key: ${stemUnit === 10 ? "2 | 5 = 25" : `stem × ${stemUnit} + leaf`}</div>
      <table class="stem-leaf-table">
        <thead><tr><th>Stem</th><th>Leaves</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildBarChartMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Category Frequencies"));
  const categoryAxisLabel = escapeInteractiveHtml(String(config.categoryAxisLabel || "Category"));
  const valueAxisLabel = escapeInteractiveHtml(String(config.valueAxisLabel || "Value"));
  const items = (Array.isArray(config.items) ? config.items : [])
    .map((item, index) => ({
      category: String(item.category || `Item ${index + 1}`).trim() || `Item ${index + 1}`,
      value: Math.max(0, Number(item.frequency) || 0),
      color: safeInteractiveColor(item.color, "#2563eb")
    }));
  const orientation = String(config.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  if (items.length === 0) {
    return "<p class='helper-text'>Add category-frequency items to preview the bar chart.</p>";
  }

  const maxItem = Math.max(...items.map((item) => item.value), 1);
  const yMax = Number.isFinite(Number(config.yMax)) && Number(config.yMax) > 0
    ? Number(config.yMax)
    : Math.ceil(maxItem / 5) * 5;
  const tickCount = 5;

  if (orientation === "horizontal") {
    const width = 560;
    const height = 300;
    const margin = { top: 26, right: 24, bottom: 54, left: 130 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const step = plotH / items.length;
    const barH = Math.max(12, step * 0.62);

    const bars = items.map((item, index) => {
      const y = margin.top + index * step + (step - barH) / 2;
      const w = Math.max(2, (item.value / yMax) * plotW);
      return `
        <text x="${margin.left - 8}" y="${y + barH / 2 + 4}" text-anchor="end" font-size="11" fill="#334155">${escapeInteractiveHtml(item.category)}</text>
        <rect x="${margin.left}" y="${y}" width="${w}" height="${barH}" fill="${item.color}" stroke="#1e293b" stroke-width="0.6"/>
        <text x="${Math.min(width - 4, margin.left + w + 6)}" y="${y + barH / 2 + 4}" font-size="11" fill="#0f172a">${item.value}</text>
      `;
    }).join("");

    const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
      const value = (yMax * index) / tickCount;
      const x = margin.left + (plotW * index) / tickCount;
      return `<line x1="${x}" y1="${height - margin.bottom}" x2="${x}" y2="${height - margin.bottom + 6}" stroke="#64748b"/><text x="${x}" y="${height - margin.bottom + 20}" text-anchor="middle" font-size="10" fill="#475569">${escapeInteractiveHtml(value.toFixed(0))}</text>`;
    }).join("");

    return `
      <div class="bar-chart-container">
        <p class="bar-chart-title">${title}</p>
        <svg class="bar-chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
          <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="#ffffff" stroke="#cbd5e1"/>
          <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#334155" stroke-width="1.4"/>
          <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#334155" stroke-width="1.4"/>
          ${bars}
          ${ticks}
          <text x="${margin.left + plotW / 2}" y="${height - 12}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b">${valueAxisLabel}</text>
          <text x="22" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b" transform="rotate(-90 22 ${margin.top + plotH / 2})">${categoryAxisLabel}</text>
        </svg>
      </div>
    `;
  }

  const width = 560;
  const height = 320;
  const margin = { top: 26, right: 22, bottom: 84, left: 62 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const step = plotW / items.length;
  const barW = Math.max(14, step * 0.62);

  const bars = items.map((item, index) => {
    const x = margin.left + index * step + (step - barW) / 2;
    const h = Math.max(2, (item.value / yMax) * plotH);
    const y = margin.top + plotH - h;
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${item.color}" stroke="#1e293b" stroke-width="0.6"/>
      <text x="${x + barW / 2}" y="${Math.max(14, y - 6)}" text-anchor="middle" font-size="10" fill="#0f172a">${item.value}</text>
      <text x="${x + barW / 2}" y="${height - margin.bottom + 16}" text-anchor="middle" font-size="10" fill="#334155">${escapeInteractiveHtml(item.category)}</text>
    `;
  }).join("");

  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => {
    const value = (yMax * index) / tickCount;
    const y = margin.top + plotH - (plotH * index) / tickCount;
    return `<line x1="${margin.left - 6}" y1="${y}" x2="${margin.left}" y2="${y}" stroke="#64748b"/><text x="${margin.left - 10}" y="${y + 4}" text-anchor="end" font-size="10" fill="#475569">${escapeInteractiveHtml(value.toFixed(0))}</text>`;
  }).join("");

  return `
    <div class="bar-chart-container">
      <p class="bar-chart-title">${title}</p>
      <svg class="bar-chart-svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="1" y="1" width="${width - 2}" height="${height - 2}" fill="#ffffff" stroke="#cbd5e1"/>
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1.4"/>
        <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${width - margin.right}" y2="${margin.top + plotH}" stroke="#334155" stroke-width="1.4"/>
        ${bars}
        ${ticks}
        <text x="${margin.left + plotW / 2}" y="${height - 12}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b">${categoryAxisLabel}</text>
        <text x="18" y="${margin.top + plotH / 2}" text-anchor="middle" font-size="12" font-weight="700" fill="#1e293b" transform="rotate(-90 18 ${margin.top + plotH / 2})">${valueAxisLabel}</text>
      </svg>
    </div>
  `;
}

function quantile(sortedValues, q) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return Number.NaN;
  const position = (sortedValues.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sortedValues[low];
  const weight = position - low;
  return sortedValues[low] * (1 - weight) + sortedValues[high] * weight;
}

function medianOfSorted(sortedValues) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return Number.NaN;
  const mid = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 0) {
    return (sortedValues[mid - 1] + sortedValues[mid]) / 2;
  }
  return sortedValues[mid];
}

function computeFiveNumber(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;

  const median = medianOfSorted(sorted);
  if (!Number.isFinite(median)) return null;

  const mid = Math.floor(sorted.length / 2);
  const lowerHalf = sorted.length % 2 === 0 ? sorted.slice(0, mid) : sorted.slice(0, mid);
  const upperHalf = sorted.length % 2 === 0 ? sorted.slice(mid) : sorted.slice(mid + 1);
  const q1 = lowerHalf.length > 0 ? medianOfSorted(lowerHalf) : median;
  const q3 = upperHalf.length > 0 ? medianOfSorted(upperHalf) : median;

  return {
    min: sorted[0],
    q1,
    median,
    q3,
    max: sorted[sorted.length - 1]
  };
}

function computeLinearRegression(points) {
  const valid = (Array.isArray(points) ? points : [])
    .map((point) => ({ x: Number(point.x), y: Number(point.y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (valid.length < 2) return null;

  const n = valid.length;
  const sumX = valid.reduce((sum, item) => sum + item.x, 0);
  const sumY = valid.reduce((sum, item) => sum + item.y, 0);
  const sumXY = valid.reduce((sum, item) => sum + item.x * item.y, 0);
  const sumXX = valid.reduce((sum, item) => sum + item.x * item.x, 0);
  const sumYY = valid.reduce((sum, item) => sum + item.y * item.y, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (Math.abs(denominator) < 1e-12) return null;
  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;
  const corrDen = Math.sqrt((n * sumXX - sumX * sumX) * (n * sumYY - sumY * sumY));
  const correlation = corrDen > 0 ? (n * sumXY - sumX * sumY) / corrDen : 0;
  return { slope, intercept, correlation };
}

function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  const prob = 1 - d * (0.319381530 * t - 0.356563782 * t ** 2 + 1.781477937 * t ** 3 - 1.821255978 * t ** 4 + 1.330274429 * t ** 5);
  return z >= 0 ? prob : 1 - prob;
}

function buildHistogramMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Continuous Data Distribution"));
  const values = (Array.isArray(config.values) ? config.values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  const binCount = Math.max(2, Math.min(30, Number.parseInt(config.binCount, 10) || 8));
  if (values.length === 0) return "<p class='helper-text'>Add numeric values to preview the histogram.</p>";

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const width = range / binCount;
  const bins = new Array(binCount).fill(0);
  values.forEach((value) => {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor((value - min) / width)));
    bins[index] += 1;
  });
  const maxFreq = Math.max(...bins, 1);
  const bars = bins.map((freq, index) => {
    const barHeight = Math.max(4, (freq / maxFreq) * 120);
    const start = min + index * width;
    const end = start + width;
    return `<div class="histogram-bin"><div class="histogram-bar" style="height:${barHeight}px"></div><span class="histogram-label">${escapeInteractiveHtml(start.toFixed(1))}-${escapeInteractiveHtml(end.toFixed(1))}</span><span class="histogram-value">${freq}</span></div>`;
  }).join("");
  return `<div class="histogram-container"><p class="bar-chart-title">${title}</p><div class="histogram-bars">${bars}</div></div>`;
}

function buildBoxPlotMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Compare Datasets"));
  const palette = ["#2563eb", "#16a34a", "#f59e0b", "#7c3aed", "#0f766e", "#dc2626", "#0891b2", "#9333ea"];
  const rows = normalizeBoxPlotDatasets(config).map((dataset, index) => ({
    label: dataset.label || defaultBoxPlotDatasetLabel(index),
    stats: computeFiveNumber(dataset.values || []),
    color: palette[index % palette.length]
  }));
  const statsList = rows.map((item) => item.stats).filter((item) => item);
  if (statsList.length === 0) return "<p class='helper-text'>Add dataset values to preview box plot summaries.</p>";

  const minValue = Math.min(...statsList.map((item) => item.min));
  const maxValue = Math.max(...statsList.map((item) => item.max));
  const axisMin = Math.floor(minValue);
  const axisMax = Math.ceil(maxValue);
  const axisRange = axisMax - axisMin || 1;
  const left = 92;
  const right = 360;
  const rowStart = 52;
  const rowGap = 40;
  const axisY = rowStart + Math.max(0, rows.length - 1) * rowGap + 30;
  const svgHeight = Math.max(172, axisY + 22);
  const mapX = (value) => left + ((value - axisMin) / axisRange) * (right - left);

  const renderRow = (label, stats, index, color) => {
    const y = rowStart + index * rowGap;
    if (!stats) {
      return `<text x="14" y="${y + 4}" font-size="12" fill="#64748b">${escapeInteractiveHtml(label)}</text><text x="${left}" y="${y + 4}" font-size="12" fill="#94a3b8">no data</text>`;
    }
    const xMin = mapX(stats.min);
    const xQ1 = mapX(stats.q1);
    const xMedian = mapX(stats.median);
    const xQ3 = mapX(stats.q3);
    const xMax = mapX(stats.max);
    return `
      <text x="14" y="${y + 4}" font-size="12" fill="#0f172a" font-weight="700">${escapeInteractiveHtml(label)}</text>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Min: ${stats.min.toFixed(2)}</title>
        <rect x="${xMin - 8}" y="${y - 15}" width="16" height="30" fill="transparent" stroke="none"/>
        <line x1="${xMin}" y1="${y - 10}" x2="${xMin}" y2="${y + 10}" stroke="#64748b" stroke-width="2"/>
      </g>
      <line x1="${xMin}" y1="${y}" x2="${xQ1}" y2="${y}" stroke="#64748b" stroke-width="2"/>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Q1: ${stats.q1.toFixed(2)}</title>
        <rect x="${Math.min(xQ1, xQ3)}" y="${y - 12}" width="${Math.max(2, Math.abs(xQ3 - xQ1))}" height="24" fill="transparent" stroke="none" pointer-events="all"/>
        <rect x="${Math.min(xQ1, xQ3)}" y="${y - 12}" width="${Math.max(2, Math.abs(xQ3 - xQ1))}" height="24" fill="${color}" fill-opacity="0.25" stroke="${color}" stroke-width="2" pointer-events="none"/>
      </g>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Median: ${stats.median.toFixed(2)}</title>
        <rect x="${xMedian - 8}" y="${y - 15}" width="16" height="30" fill="transparent" stroke="none"/>
        <line x1="${xMedian}" y1="${y - 12}" x2="${xMedian}" y2="${y + 12}" stroke="${color}" stroke-width="2"/>
      </g>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Q3: ${stats.q3.toFixed(2)}</title>
        <rect x="${Math.min(xQ1, xQ3)}" y="${y - 12}" width="${Math.max(2, Math.abs(xQ3 - xQ1))}" height="24" fill="transparent" stroke="none" pointer-events="all"/>
      </g>
      <line x1="${xQ3}" y1="${y}" x2="${xMax}" y2="${y}" stroke="#64748b" stroke-width="2"/>
      <g style="cursor:pointer" class="box-plot-hover">
        <title>Max: ${stats.max.toFixed(2)}</title>
        <rect x="${xMax - 8}" y="${y - 15}" width="16" height="30" fill="transparent" stroke="none"/>
        <line x1="${xMax}" y1="${y - 10}" x2="${xMax}" y2="${y + 10}" stroke="#64748b" stroke-width="2"/>
      </g>
      <text x="${xMin}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">min</text>
      <text x="${xQ1}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">Q1</text>
      <text x="${xMedian}" y="${y - 20}" text-anchor="middle" font-size="9" fill="${color}" font-weight="700">median</text>
      <text x="${xQ3}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">Q3</text>
      <text x="${xMax}" y="${y - 15}" text-anchor="middle" font-size="9" fill="#64748b" font-weight="600">max</text>
    `;
  };

  const axisTickValues = [];
  for (let value = axisMin; value <= axisMax; value += 1) {
    axisTickValues.push(value);
  }
  const labelSkip = axisTickValues.length > 24 ? Math.ceil(axisTickValues.length / 24) : 1;
  const axisTicks = axisTickValues.map((value, index) => {
    const x = mapX(value);
    const label = index % labelSkip === 0
      ? `<text x="${x}" y="${axisY + 15}" text-anchor="middle" font-size="10" fill="#64748b">${value}</text>`
      : "";
    return `<line x1="${x}" y1="${axisY - 4}" x2="${x}" y2="${axisY + 2}" stroke="#94a3b8"/>${label}`;
  }).join("");

  const summaryLine = (label, stats) => {
    if (!stats) return `<p>${escapeInteractiveHtml(label)}: no data</p>`;
    return `<p>${escapeInteractiveHtml(label)}: min=${stats.min.toFixed(2)}, Q1=${stats.q1.toFixed(2)}, median=${stats.median.toFixed(2)}, Q3=${stats.q3.toFixed(2)}, max=${stats.max.toFixed(2)}</p>`;
  };

  const renderedRows = rows.map((row, index) => renderRow(row.label, row.stats, index, row.color)).join("");
  const renderedSummary = rows.map((row) => summaryLine(row.label, row.stats)).join("");

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <svg viewBox="0 0 380 ${svgHeight}" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="380" height="${svgHeight}" fill="#f8fafc" stroke="#dbe6f3"/>
        ${renderedRows}
        <line x1="${left}" y1="${axisY}" x2="${right}" y2="${axisY}" stroke="#64748b" stroke-width="1.5"/>
        ${axisTicks}
      </svg>
      ${renderedSummary}
    </div>
  `;
}

function buildScatterPlotMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Correlation and Best Fit"));
  const points = (Array.isArray(config.points) ? config.points : [])
    .map((point) => ({
      x: Number(point.x),
      y: Number(point.y),
      label: point.label,
      color: point.color
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const regression = computeLinearRegression(points);
  if (points.length === 0) return "<p class='helper-text'>Add points to preview scatter plot analytics.</p>";

  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const yMin = Math.min(...points.map((point) => point.y));
  const yMax = Math.max(...points.map((point) => point.y));
  const xPad = (xMax - xMin || 1) * 0.12;
  const yPad = (yMax - yMin || 1) * 0.12;
  const domainXMin = xMin - xPad;
  const domainXMax = xMax + xPad;
  const domainYMin = yMin - yPad;
  const domainYMax = yMax + yPad;
  const left = 50;
  const right = 362;
  const top = 18;
  const bottom = 198;
  const mapX = (value) => left + ((value - domainXMin) / (domainXMax - domainXMin || 1)) * (right - left);
  const mapY = (value) => bottom - ((value - domainYMin) / (domainYMax - domainYMin || 1)) * (bottom - top);

  const pointsSvg = points.map((point, index) => {
    const px = mapX(point.x);
    const py = mapY(point.y);
    const color = safeInteractiveColor(point.color, "#2563eb");
    const label = escapeInteractiveHtml(String(point.label || `P${index + 1}`));
    return `<circle cx="${px}" cy="${py}" r="4" fill="${color}" stroke="#0f172a" stroke-width="0.8"/><text x="${px + 6}" y="${py - 6}" font-size="10" fill="#334155">${label}</text>`;
  }).join("");

  const fitLine = regression
    ? (() => {
      const x1 = domainXMin;
      const y1 = regression.slope * x1 + regression.intercept;
      const x2 = domainXMax;
      const y2 = regression.slope * x2 + regression.intercept;
      return `<line x1="${mapX(x1)}" y1="${mapY(y1)}" x2="${mapX(x2)}" y2="${mapY(y2)}" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 4"/>`;
    })()
    : "";

  const detail = regression
    ? `r = ${regression.correlation.toFixed(3)}, best fit: y = ${regression.slope.toFixed(3)}x + ${regression.intercept.toFixed(3)}`
    : "Not enough variation for line of best fit.";
  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <svg viewBox="0 0 380 210" width="100%" preserveAspectRatio="xMidYMid meet">
        <rect x="0" y="0" width="380" height="210" fill="#f8fafc" stroke="#dbe6f3"/>
        <line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#64748b" stroke-width="1.5"/>
        <line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#64748b" stroke-width="1.5"/>
        ${fitLine}
        ${pointsSvg}
        <text x="${left}" y="206" font-size="10" fill="#64748b">x: ${escapeInteractiveHtml(domainXMin.toFixed(2))}</text>
        <text x="${right}" y="206" text-anchor="end" font-size="10" fill="#64748b">${escapeInteractiveHtml(domainXMax.toFixed(2))}</text>
        <text x="6" y="${bottom}" font-size="10" fill="#64748b">y: ${escapeInteractiveHtml(domainYMin.toFixed(2))}</text>
        <text x="6" y="${top + 10}" font-size="10" fill="#64748b">${escapeInteractiveHtml(domainYMax.toFixed(2))}</text>
      </svg>
      <p>Point count: ${points.length}</p>
      <p>${escapeInteractiveHtml(detail)}</p>
    </div>
  `;
}

function buildProbabilityTreeMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Sequential Probabilities"));
  const paths = Array.isArray(config.paths) ? config.paths : [];
  if (paths.length === 0) return "<p class='helper-text'>Add probability paths to preview the tree summary.</p>";
  const total = paths.reduce((sum, item) => sum + (Number(item.probability) || 0), 0);
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Path count: ${paths.length}</p><p>Total probability: ${total.toFixed(3)}</p><p class="helper-text">Conditional query: ${escapeInteractiveHtml(String(config.conditionalQuery || "none"))}</p></div>`;
}

function buildDistributionCurveMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Normal Distribution"));
  const mean = Number(config.mean);
  const stdDev = Math.max(0.0001, Number(config.stdDev) || 1);
  const from = Number(config.from);
  const to = Number(config.to);
  if (![mean, stdDev, from, to].every(Number.isFinite)) return "<p class='helper-text'>Set mean, standard deviation, and interval to preview distribution.</p>";
  const zFrom = (from - mean) / stdDev;
  const zTo = (to - mean) / stdDev;
  const area = Math.max(0, normalCdf(zTo) - normalCdf(zFrom));
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Mean = ${mean.toFixed(3)}, SD = ${stdDev.toFixed(3)}</p><p>Area from ${from.toFixed(3)} to ${to.toFixed(3)} ≈ ${area.toFixed(4)}</p></div>`;
}

function buildNetworkGraphMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Network Graph"));
  const nodes = Array.isArray(config.nodes) ? config.nodes : [];
  const edges = Array.isArray(config.edges) ? config.edges : [];
  if (nodes.length === 0 || edges.length === 0) return "<p class='helper-text'>Add nodes and edges to preview network analysis.</p>";
  return `<div class="simple-card"><p class="bar-chart-title">${title}</p><p>Nodes: ${nodes.length}</p><p>Edges: ${edges.length}</p><p class="helper-text">Shortest path: ${escapeInteractiveHtml(String(config.source || ""))} to ${escapeInteractiveHtml(String(config.target || ""))}</p><p class="helper-text">Flow: ${escapeInteractiveHtml(String(config.flowSource || ""))} to ${escapeInteractiveHtml(String(config.flowSink || ""))}</p></div>`;
}

function normalizeFractionOperation(value) {
  const operation = String(value || "add").trim().toLowerCase();
  return ["add", "subtract", "multiply", "divide"].includes(operation) ? operation : "add";
}

function gcdFraction(a, b) {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function simplifyFraction(numerator, denominator) {
  const n = Math.trunc(Number(numerator));
  const d = Math.trunc(Number(denominator));
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  let nextN = n;
  let nextD = d;
  if (nextD < 0) {
    nextN *= -1;
    nextD *= -1;
  }
  const divisor = gcdFraction(nextN, nextD);
  return {
    numerator: nextN / divisor,
    denominator: nextD / divisor
  };
}

function formatFractionDisplay(fraction) {
  if (!fraction) return "invalid";
  if (fraction.denominator === 1) return `${fraction.numerator}`;
  return `${fraction.numerator}/${fraction.denominator}`;
}

function buildFractionsMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Fraction Operations"));
  const operation = normalizeFractionOperation(config.operation);
  const labels = {
    add: "+",
    subtract: "-",
    multiply: "x",
    divide: "�"
  };

  const fractionA = simplifyFraction(config.fractionA && config.fractionA.numerator, config.fractionA && config.fractionA.denominator);
  const fractionB = simplifyFraction(config.fractionB && config.fractionB.numerator, config.fractionB && config.fractionB.denominator);

  if (!fractionA || !fractionB) {
    return "<p class='helper-text'>Enter two valid fractions with non-zero denominators.</p>";
  }

  if (operation === "divide" && fractionB.numerator === 0) {
    return "<p class='helper-text'>Division by zero is undefined. Fraction B numerator must not be 0.</p>";
  }

  let rawResult = null;
  if (operation === "add") {
    rawResult = {
      numerator: fractionA.numerator * fractionB.denominator + fractionB.numerator * fractionA.denominator,
      denominator: fractionA.denominator * fractionB.denominator
    };
  } else if (operation === "subtract") {
    rawResult = {
      numerator: fractionA.numerator * fractionB.denominator - fractionB.numerator * fractionA.denominator,
      denominator: fractionA.denominator * fractionB.denominator
    };
  } else if (operation === "multiply") {
    rawResult = {
      numerator: fractionA.numerator * fractionB.numerator,
      denominator: fractionA.denominator * fractionB.denominator
    };
  } else {
    rawResult = {
      numerator: fractionA.numerator * fractionB.denominator,
      denominator: fractionA.denominator * fractionB.numerator
    };
  }

  const result = simplifyFraction(rawResult.numerator, rawResult.denominator);
  if (!result) {
    return "<p class='helper-text'>Could not compute this fraction operation.</p>";
  }

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <p>${escapeInteractiveHtml(formatFractionDisplay(fractionA))} ${labels[operation]} ${escapeInteractiveHtml(formatFractionDisplay(fractionB))} = ${escapeInteractiveHtml(formatFractionDisplay(result))}</p>
      <p class="helper-text">Result (simplified): ${escapeInteractiveHtml(formatFractionDisplay(result))}</p>
    </div>
  `;
}

function normalizeMatrixOperation(value) {
  const operation = String(value || "multiply").trim().toLowerCase();
  return ["add", "subtract", "multiply", "determinant", "transpose"].includes(operation) ? operation : "multiply";
}

function sanitizeMatrix(matrix) {
  if (!Array.isArray(matrix)) return [];
  return matrix
    .map((row) => (Array.isArray(row) ? row : []))
    .map((row) => row.map((value) => Number(value)).filter((value) => Number.isFinite(value)))
    .filter((row) => row.length > 0);
}

function matrixIsRectangular(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return false;
  const width = matrix[0].length;
  return width > 0 && matrix.every((row) => Array.isArray(row) && row.length === width && row.every((value) => Number.isFinite(value)));
}

function matrixDimensions(matrix) {
  if (!matrixIsRectangular(matrix)) return "invalid";
  return `${matrix.length}x${matrix[0].length}`;
}

function matrixAdd(a, b) {
  if (!matrixIsRectangular(a) || !matrixIsRectangular(b)) return null;
  if (a.length !== b.length || a[0].length !== b[0].length) return null;
  return a.map((row, rowIndex) => row.map((value, colIndex) => value + b[rowIndex][colIndex]));
}

function matrixSubtract(a, b) {
  if (!matrixIsRectangular(a) || !matrixIsRectangular(b)) return null;
  if (a.length !== b.length || a[0].length !== b[0].length) return null;
  return a.map((row, rowIndex) => row.map((value, colIndex) => value - b[rowIndex][colIndex]));
}

function matrixMultiply(a, b) {
  if (!matrixIsRectangular(a) || !matrixIsRectangular(b)) return null;
  if (a[0].length !== b.length) return null;
  return a.map((row) => b[0].map((_, colIndex) => row.reduce((sum, value, k) => sum + value * b[k][colIndex], 0)));
}

function matrixTranspose(a) {
  if (!matrixIsRectangular(a)) return null;
  return a[0].map((_, colIndex) => a.map((row) => row[colIndex]));
}

function matrixDeterminant(matrix) {
  if (!matrixIsRectangular(matrix)) return Number.NaN;
  const size = matrix.length;
  if (size !== matrix[0].length) return Number.NaN;
  if (size === 1) return matrix[0][0];
  if (size === 2) return matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  let total = 0;
  for (let col = 0; col < size; col += 1) {
    const minor = matrix.slice(1).map((row) => row.filter((_, index) => index !== col));
    total += (col % 2 === 0 ? 1 : -1) * matrix[0][col] * matrixDeterminant(minor);
  }
  return total;
}

function formatMatrixNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "?";
  const rounded = Math.round(numeric * 1000) / 1000;
  return String(rounded);
}

function buildMatrixTableMarkup(matrix, caption) {
  if (!matrixIsRectangular(matrix)) {
    return `<div class="simple-card"><p>${escapeInteractiveHtml(caption)}: invalid matrix</p></div>`;
  }
  const rows = matrix
    .map((row) => `<tr>${row.map((value) => `<td style="border:1px solid #cbd5e1;padding:4px 8px;text-align:right;">${escapeInteractiveHtml(formatMatrixNumber(value))}</td>`).join("")}</tr>`)
    .join("");
  return `
    <div class="simple-card">
      <p><strong>${escapeInteractiveHtml(caption)}</strong> (${matrix.length}x${matrix[0].length})</p>
      <table style="border-collapse:collapse; margin-top:6px;">
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function buildMatrixMarkup(config) {
  const title = escapeInteractiveHtml(String(config.title || "Matrix Operations"));
  const operation = normalizeMatrixOperation(config.operation);
  const matrixA = sanitizeMatrix(config.matrixA);
  const matrixB = sanitizeMatrix(config.matrixB);

  if (!matrixIsRectangular(matrixA)) {
    return "<p class='helper-text'>Enter a valid rectangular matrix A to preview matrix operations.</p>";
  }

  const labels = {
    add: "A + B",
    subtract: "A - B",
    multiply: "A x B",
    determinant: "det(A)",
    transpose: "A^T"
  };

  let resultMarkup = "";
  if (operation === "add") {
    const result = matrixAdd(matrixA, matrixB);
    resultMarkup = result
      ? buildMatrixTableMarkup(result, "Result")
      : "<p class='helper-text'>For addition, A and B must have the same dimensions.</p>";
  } else if (operation === "subtract") {
    const result = matrixSubtract(matrixA, matrixB);
    resultMarkup = result
      ? buildMatrixTableMarkup(result, "Result")
      : "<p class='helper-text'>For subtraction, A and B must have the same dimensions.</p>";
  } else if (operation === "multiply") {
    const result = matrixMultiply(matrixA, matrixB);
    resultMarkup = result
      ? buildMatrixTableMarkup(result, "Result")
      : "<p class='helper-text'>For multiplication, columns in A must equal rows in B.</p>";
  } else if (operation === "determinant") {
    const determinant = matrixDeterminant(matrixA);
    resultMarkup = Number.isFinite(determinant)
      ? `<div class="simple-card"><p><strong>det(A)</strong> = ${escapeInteractiveHtml(formatMatrixNumber(determinant))}</p></div>`
      : "<p class='helper-text'>Determinant requires A to be a square matrix.</p>";
  } else {
    const result = matrixTranspose(matrixA);
    resultMarkup = result ? buildMatrixTableMarkup(result, "A^T") : "<p class='helper-text'>Transpose requires a valid matrix A.</p>";
  }

  return `
    <div class="simple-card">
      <p class="bar-chart-title">${title}</p>
      <p>Operation: ${escapeInteractiveHtml(labels[operation])}</p>
      <p class="helper-text">A dimensions: ${escapeInteractiveHtml(matrixDimensions(matrixA))}${operation === "add" || operation === "subtract" || operation === "multiply" ? ` | B dimensions: ${escapeInteractiveHtml(matrixDimensions(matrixB))}` : ""}</p>
    </div>
    ${buildMatrixTableMarkup(matrixA, "Matrix A")}
    ${(operation === "add" || operation === "subtract" || operation === "multiply") && matrixB.length > 0 ? buildMatrixTableMarkup(matrixB, "Matrix B") : ""}
    ${resultMarkup}
  `;
}

function buildGeometryShapesMarkup(config) {
  const canvasWidth = Math.max(220, Math.min(760, Number.parseInt(config.canvasWidth, 10) || 360));
  const canvasHeight = Math.max(180, Math.min(520, Number.parseInt(config.canvasHeight, 10) || 260));
  const shapes = Array.isArray(config.shapes) ? config.shapes : [];
  if (shapes.length === 0) {
    return "<p class='helper-text'>Add shapes to preview geometry.</p>";
  }

  const parts = [];
  parts.push(`<rect x="0" y="0" width="${canvasWidth}" height="${canvasHeight}" fill="#f8fbff" stroke="#dbe6f3"/>`);

  shapes.forEach((shape) => {
    const type = normalizeGeometryShapeType(shape.type);
    const x = Number(shape.x);
    const y = Number(shape.y);
    const w = Math.max(6, Number(shape.w) || 40);
    const h = Math.max(6, Number(shape.h) || w);
    if (![x, y].every(Number.isFinite)) return;
    const stroke = safeInteractiveColor(shape.color, "#2563eb");
    const fill = safeInteractiveColor(shape.fill, "#dbeafe");
    const label = escapeInteractiveHtml(String(shape.label || ""));

    if (type === "rectangle") {
      parts.push(`<rect x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "square") {
      parts.push(`<rect x="${x - w / 2}" y="${y - w / 2}" width="${w}" height="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "circle") {
      parts.push(`<circle cx="${x}" cy="${y}" r="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "triangle") {
      parts.push(`<polygon points="${x},${y - h / 2} ${x - w / 2},${y + h / 2} ${x + w / 2},${y + h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "cube" || type === "cuboid") {
      const depth = Math.max(8, Number(shape.d) || Math.min(w, h) / 2);
      const left = x - w / 2;
      const top = y - h / 2;
      parts.push(`<rect x="${left}" y="${top}" width="${w}" height="${h}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<polygon points="${left},${top} ${left + depth},${top - depth} ${left + w + depth},${top - depth} ${left + w},${top}" fill="${fill}" fill-opacity="0.75" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<polygon points="${left + w},${top} ${left + w + depth},${top - depth} ${left + w + depth},${top + h - depth} ${left + w},${top + h}" fill="${fill}" fill-opacity="0.6" stroke="${stroke}" stroke-width="2"/>`);
    } else if (type === "sphere") {
      parts.push(`<circle cx="${x}" cy="${y}" r="${w}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<ellipse cx="${x}" cy="${y}" rx="${w}" ry="${Math.max(6, w * 0.32)}" fill="none" stroke="${stroke}" stroke-opacity="0.45" stroke-width="1.5"/>`);
    } else if (type === "cylinder") {
      const radius = w;
      const bodyH = h;
      parts.push(`<ellipse cx="${x}" cy="${y - bodyH / 2}" rx="${radius}" ry="${Math.max(6, radius * 0.35)}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<rect x="${x - radius}" y="${y - bodyH / 2}" width="${radius * 2}" height="${bodyH}" fill="${fill}" fill-opacity="0.7" stroke="${stroke}" stroke-width="2"/>`);
      parts.push(`<ellipse cx="${x}" cy="${y + bodyH / 2}" rx="${radius}" ry="${Math.max(6, radius * 0.35)}" fill="${fill}" stroke="${stroke}" stroke-width="2"/>`);
    }

    if (label) {
      parts.push(`<text x="${x}" y="${y - Math.max(h, w) / 2 - 8}" text-anchor="middle" font-size="11" fill="${stroke}" font-weight="bold">${label}</text>`);
    }
  });

  return `<div class="geometry-shapes-container"><svg viewBox="0 0 ${canvasWidth} ${canvasHeight}" width="100%" preserveAspectRatio="xMidYMid meet">${parts.join("")}</svg></div>`;
}

function buildPythagorasMarkup(config) {
  const sideA = escapeInteractiveHtml(config.sideA || "?");
  const sideB = escapeInteractiveHtml(config.sideB || "?");
  const sideC = escapeInteractiveHtml(config.sideC || "?");
  const caption = escapeInteractiveHtml(config.caption || "Use a² + b² = c²");
  return `
    <div class="triangle-demo-card">
      <svg viewBox="0 0 320 240" width="100%" preserveAspectRatio="xMidYMid meet">
        <polygon points="60,200 60,70 250,200" fill="#eff6ff" stroke="#1d4ed8" stroke-width="3"/>
        <polyline points="60,200 84,200 84,176 60,176" fill="none" stroke="#334155" stroke-width="2"/>
        <text x="42" y="142" font-size="14" fill="#1e3a8a" font-weight="bold">a = ${sideA}</text>
        <text x="140" y="220" font-size="14" fill="#1e3a8a" font-weight="bold">b = ${sideB}</text>
        <text x="168" y="124" font-size="14" fill="#b45309" font-weight="bold">c = ${sideC}</text>
      </svg>
      <p class="triangle-demo-caption">${caption}</p>
    </div>
  `;
}

function buildTrigSummary(config) {
  const focusFunction = ["sin", "cos", "tan"].includes(config.focusFunction) ? config.focusFunction : "sin";
  const opposite = String(config.opposite || "?").trim() || "?";
  const adjacent = String(config.adjacent || "?").trim() || "?";
  const hypotenuse = String(config.hypotenuse || "?").trim() || "?";
  const numMap = { sin: opposite, cos: adjacent, tan: opposite };
  const denMap = { sin: hypotenuse, cos: hypotenuse, tan: adjacent };
  const numericNum = Number.parseFloat(numMap[focusFunction]);
  const numericDen = Number.parseFloat(denMap[focusFunction]);
  const approx = Number.isFinite(numericNum) && Number.isFinite(numericDen) && numericDen !== 0
    ? ` ≈ ${(numericNum / numericDen).toFixed(3)}`
    : "";
  return `${focusFunction} θ = ${numMap[focusFunction]} / ${denMap[focusFunction]}${approx}`;
}

function buildTrigonometryMarkup(config) {
  const angleDeg = Number.parseFloat(config.angleDeg);
  const angleLabel = Number.isFinite(angleDeg) ? `${angleDeg}°` : "θ";
  const opposite = escapeInteractiveHtml(config.opposite || "?");
  const adjacent = escapeInteractiveHtml(config.adjacent || "?");
  const hypotenuse = escapeInteractiveHtml(config.hypotenuse || "?");
  const summary = escapeInteractiveHtml(buildTrigSummary(config));
  return `
    <div class="triangle-demo-card">
      <svg viewBox="0 0 320 240" width="100%" preserveAspectRatio="xMidYMid meet">
        <polygon points="60,200 220,200 220,80" fill="#f0fdf4" stroke="#15803d" stroke-width="3"/>
        <polyline points="220,200 196,200 196,176 220,176" fill="none" stroke="#334155" stroke-width="2"/>
        <path d="M 90 200 A 30 30 0 0 0 84 183" fill="none" stroke="#dc2626" stroke-width="2"/>
        <text x="86" y="186" font-size="13" fill="#dc2626" font-weight="bold">${escapeInteractiveHtml(angleLabel)}</text>
        <text x="124" y="220" font-size="14" fill="#166534" font-weight="bold">adj = ${adjacent}</text>
        <text x="234" y="146" font-size="14" fill="#166534" font-weight="bold">opp = ${opposite}</text>
        <text x="146" y="128" font-size="14" fill="#b45309" font-weight="bold">hyp = ${hypotenuse}</text>
      </svg>
      <p class="triangle-demo-caption">${summary}</p>
    </div>
  `;
}

function buildInteractiveAppMarkup(app) {
  if (!app || !app.type) return "<p class='helper-text'>Choose a template to add an optional interactive math visual.</p>";
  switch (app.type) {
    case "number-line":
      return buildNumberLineMarkup(app.config || {});
    case "cartesian-plane":
      return buildCartesianPlaneMarkup(app.config || {});
    case "cartesian-plane-plot":
      return buildCartesianPlotMarkup(app.config || {});
    case "bar-chart":
      return buildBarChartMarkup(app.config || {});
    case "histogram":
      return buildHistogramMarkup(app.config || {});
    case "box-plot":
      return buildBoxPlotMarkup(app.config || {});
    case "scatter-plot":
      return buildScatterPlotMarkup(app.config || {});
    case "probability-tree":
      return buildProbabilityTreeMarkup(app.config || {});
    case "distribution-curve":
      return buildDistributionCurveMarkup(app.config || {});
    case "fractions":
      return buildFractionsMarkup(app.config || {});
    case "network-graph":
      return buildNetworkGraphMarkup(app.config || {});
    case "matrix":
      return buildMatrixMarkup(app.config || {});
    case "stem-and-leaf":
      return buildStemLeafMarkup(app.config || {});
    case "geometry-shapes":
      return buildGeometryShapesMarkup(app.config || {});
    case "pythagoras":
      return buildPythagorasMarkup(app.config || {});
    case "trigonometry":
      return buildTrigonometryMarkup(app.config || {});
    default:
      return "<p class='helper-text'>This interactive template is not supported.</p>";
  }
}

let interactiveAppTypeOptionsCache = null;

function getInteractiveAppTypeOptions() {
  if (Array.isArray(interactiveAppTypeOptionsCache)) {
    return interactiveAppTypeOptionsCache;
  }

  const typeSelect = document.getElementById("interactiveAppType");
  if (!typeSelect) {
    interactiveAppTypeOptionsCache = [];
    return interactiveAppTypeOptionsCache;
  }

  interactiveAppTypeOptionsCache = Array.from(typeSelect.options)
    .map((option) => ({
      value: String(option.value || "").trim(),
      label: String(option.textContent || "").trim()
    }))
    .filter((item) => item.value !== "")
    .sort((a, b) => a.label.localeCompare(b.label));

  return interactiveAppTypeOptionsCache;
}

function renderInteractiveAppTypeOptions(forcedValue = "") {
  const typeSelect = document.getElementById("interactiveAppType");
  if (!typeSelect) return;

  const activeValue = String(forcedValue || typeSelect.value || "").trim();
  const options = getInteractiveAppTypeOptions();

  typeSelect.innerHTML = "";
  const noneOption = document.createElement("option");
  noneOption.value = "";
  noneOption.textContent = "None";
  typeSelect.appendChild(noneOption);

  options.forEach((item) => {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    typeSelect.appendChild(option);
  });

  typeSelect.value = options.some((item) => item.value === activeValue) ? activeValue : "";
}

function initializeInteractiveAppTypePicker() {
  const typeSelect = document.getElementById("interactiveAppType");
  if (!typeSelect) return;

  interactiveAppTypeOptionsCache = null;
  renderInteractiveAppTypeOptions(typeSelect.value);
}
function renderInteractiveAppPreview(app) {
  const preview = document.getElementById("interactiveAppPreview");
  if (!preview) return;
  preview.innerHTML = buildInteractiveAppMarkup(app);
}

function setInteractiveAppConfigVisibility(type) {
  ["numberLineConfig", "cartesianPlaneConfig", "cartesianPlotConfig", "barChartConfig", "histogramConfig", "boxPlotConfig", "scatterPlotConfig", "probabilityTreeConfig", "distributionCurveConfig", "fractionsConfig", "networkGraphConfig", "matrixConfig", "stemLeafConfig", "geometryShapesConfig", "pythagorasConfig", "trigonometryConfig"]
    .forEach((id) => {
      const element = document.getElementById(id);
      if (element) {
        const matches = id === "numberLineConfig"
          ? type === "number-line"
          : id === "cartesianPlaneConfig"
            ? type === "cartesian-plane"
          : id === "cartesianPlotConfig"
            ? type === "cartesian-plane-plot"
            : id === "barChartConfig"
              ? type === "bar-chart"
              : id === "histogramConfig"
                ? type === "histogram"
                : id === "boxPlotConfig"
                  ? type === "box-plot"
                  : id === "scatterPlotConfig"
                    ? type === "scatter-plot"
                    : id === "probabilityTreeConfig"
                      ? type === "probability-tree"
                      : id === "distributionCurveConfig"
                        ? type === "distribution-curve"
                        : id === "fractionsConfig"
                          ? type === "fractions"
                        : id === "networkGraphConfig"
                            ? type === "network-graph"
            : id === "matrixConfig"
              ? type === "matrix"
            : id === "stemLeafConfig"
              ? type === "stem-and-leaf"
              : id === "geometryShapesConfig"
                ? type === "geometry-shapes"
              : id === "pythagorasConfig"
                ? type === "pythagoras"
                : type === "trigonometry";
        element.classList.toggle("hidden", !matches);
      }
    });
}

function readInteractiveAppFromForm() {
  const type = String(document.getElementById("interactiveAppType").value || "").trim();
  if (!type) return null;

  switch (type) {
    case "number-line": {
      const min = Number.parseFloat(document.getElementById("nlMin").value);
      const max = Number.parseFloat(document.getElementById("nlMax").value);
      return {
        type,
        config: {
          min: Number.isFinite(min) ? min : -10,
          max: Number.isFinite(max) ? max : 10,
          points: parseNlPoints(document.getElementById("nlPoints").value),
          arrows: parseNlArrows(document.getElementById("nlArrows").value)
        }
      };
    }
    case "cartesian-plane": {
      const xMin = Number.parseFloat(document.getElementById("cpXMin").value);
      const xMax = Number.parseFloat(document.getElementById("cpXMax").value);
      const yMin = Number.parseFloat(document.getElementById("cpYMin").value);
      const yMax = Number.parseFloat(document.getElementById("cpYMax").value);
      const angleMode = String(document.getElementById("cpAngleMode").value || "radians").trim() || "radians";
      return {
        type,
        config: {
          xMin: Number.isFinite(xMin) ? xMin : -10,
          xMax: Number.isFinite(xMax) ? xMax : 10,
          yMin: Number.isFinite(yMin) ? yMin : -10,
          yMax: Number.isFinite(yMax) ? yMax : 10,
          angleMode: angleMode === "degrees" ? "degrees" : "radians",
          points: parseCartesianPoints(document.getElementById("cpPoints").value),
          segments: parseCartesianSegments(document.getElementById("cpSegments").value),
          parabolas: parseCartesianParabolas(document.getElementById("cpParabolas").value),
          functions: parseCartesianFunctions(document.getElementById("cpFunctions").value)
        }
      };
    }
    case "cartesian-plane-plot": {
      const cppXMin = Number.parseFloat(document.getElementById("cppXMin").value);
      const cppXMax = Number.parseFloat(document.getElementById("cppXMax").value);
      const cppYMin = Number.parseFloat(document.getElementById("cppYMin").value);
      const cppYMax = Number.parseFloat(document.getElementById("cppYMax").value);
      const cppTolerance = Number.parseFloat(document.getElementById("cppTolerance").value);
      const cppVceTemplate = String(document.getElementById("cppVceTemplate").value || "").trim();
      const cppPresetType = String(document.getElementById("cppPresetType").value || "linear").trim() || "linear";
      const cppPresetExpression = String(document.getElementById("cppPresetExpression").value || "").trim();
      const cppPresetXValues = String(document.getElementById("cppPresetXValues").value || "").trim();
      return {
        type,
        config: {
          xMin: Number.isFinite(cppXMin) ? cppXMin : -10,
          xMax: Number.isFinite(cppXMax) ? cppXMax : 10,
          yMin: Number.isFinite(cppYMin) ? cppYMin : -10,
          yMax: Number.isFinite(cppYMax) ? cppYMax : 10,
          tolerance: Number.isFinite(cppTolerance) && cppTolerance >= 0 ? cppTolerance : 0.5,
          points: parseCartesianPoints(document.getElementById("cppPoints").value),
          vceTemplate: cppVceTemplate,
          presetType: cppPresetType,
          presetExpression: cppPresetExpression || defaultCartesianPlotPresetExpression(cppPresetType),
          presetXValues: cppPresetXValues || defaultCartesianPlotPresetXValues(cppPresetType)
        }
      };
    }
    case "bar-chart": {
      const yMaxRaw = Number.parseFloat(document.getElementById("bcYMax").value);
      const orientation = String(document.getElementById("bcOrientation").value || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
      return {
        type,
        config: {
          title: document.getElementById("bcTitle").value.trim() || "Category Frequencies",
          orientation,
          categoryAxisLabel: document.getElementById("bcCategoryAxisLabel").value.trim() || "Category",
          valueAxisLabel: document.getElementById("bcValueAxisLabel").value.trim() || "Value",
          yMax: Number.isFinite(yMaxRaw) && yMaxRaw > 0 ? yMaxRaw : null,
          items: parseBarChartItems(document.getElementById("bcItems").value)
        }
      };
    }
    case "histogram": {
      const binCount = Number.parseInt(document.getElementById("histBinCount").value, 10);
      return {
        type,
        config: {
          title: document.getElementById("histTitle").value.trim() || "Continuous Data Distribution",
          values: parseNumericList(document.getElementById("histValues").value),
          binCount: Number.isInteger(binCount) ? Math.max(2, Math.min(30, binCount)) : 8
        }
      };
    }
    case "box-plot":
      {
        const datasetCount = clampBoxPlotDatasetCount(document.getElementById("boxDatasetCount").value);
        const datasets = parseBoxPlotDatasetsFromText(document.getElementById("boxDatasets").value, datasetCount);
        return {
          type,
          config: {
            title: document.getElementById("boxTitle").value.trim() || "Compare Datasets",
            datasets
          }
        };
      }
    case "scatter-plot":
      return {
        type,
        config: {
          title: document.getElementById("scTitle").value.trim() || "Correlation and Best Fit",
          points: parseCartesianPoints(document.getElementById("scPoints").value)
        }
      };
    case "probability-tree":
      return {
        type,
        config: {
          title: document.getElementById("ptTitle").value.trim() || "Sequential Probabilities",
          paths: parseProbabilityTreePaths(document.getElementById("ptPaths").value),
          conditionalQuery: document.getElementById("ptConditional").value.trim()
        }
      };
    case "distribution-curve": {
      const mean = Number.parseFloat(document.getElementById("dcMean").value);
      const stdDev = Number.parseFloat(document.getElementById("dcStdDev").value);
      const from = Number.parseFloat(document.getElementById("dcFrom").value);
      const to = Number.parseFloat(document.getElementById("dcTo").value);
      return {
        type,
        config: {
          title: document.getElementById("dcTitle").value.trim() || "Normal Distribution",
          mean: Number.isFinite(mean) ? mean : 0,
          stdDev: Number.isFinite(stdDev) && stdDev > 0 ? stdDev : 1,
          from: Number.isFinite(from) ? from : -1,
          to: Number.isFinite(to) ? to : 1
        }
      };
    }
    case "fractions": {
      const numeratorA = Number.parseInt(document.getElementById("fxNumeratorA").value, 10);
      const denominatorA = Number.parseInt(document.getElementById("fxDenominatorA").value, 10);
      const numeratorB = Number.parseInt(document.getElementById("fxNumeratorB").value, 10);
      const denominatorB = Number.parseInt(document.getElementById("fxDenominatorB").value, 10);
      return {
        type,
        config: {
          title: document.getElementById("fxTitle").value.trim() || "Fraction Operations",
          operation: normalizeFractionOperation(document.getElementById("fxOperation").value),
          fractionA: {
            numerator: Number.isInteger(numeratorA) ? numeratorA : 1,
            denominator: Number.isInteger(denominatorA) && denominatorA !== 0 ? denominatorA : 2
          },
          fractionB: {
            numerator: Number.isInteger(numeratorB) ? numeratorB : 1,
            denominator: Number.isInteger(denominatorB) && denominatorB !== 0 ? denominatorB : 3
          }
        }
      };
    }
    case "network-graph":
      return {
        type,
        config: {
          title: document.getElementById("ngTitle").value.trim() || "Shortest Path, MST, Flow",
          nodes: parseNetworkNodes(document.getElementById("ngNodes").value),
          edges: parseNetworkEdges(document.getElementById("ngEdges").value),
          source: document.getElementById("ngSource").value.trim(),
          target: document.getElementById("ngTarget").value.trim(),
          flowSource: document.getElementById("ngFlowSource").value.trim(),
          flowSink: document.getElementById("ngFlowSink").value.trim()
        }
      };
    case "matrix":
      return {
        type,
        config: {
          title: document.getElementById("mxTitle").value.trim() || "Matrix Operations",
          operation: normalizeMatrixOperation(document.getElementById("mxOperation").value),
          matrixA: parseMatrixRows(document.getElementById("mxMatrixA").value),
          matrixB: parseMatrixRows(document.getElementById("mxMatrixB").value)
        }
      };
    case "stem-and-leaf": {
      const stemUnit = Number.parseInt(document.getElementById("slStemUnit").value, 10);
      return {
        type,
        config: {
          values: parseNumericList(document.getElementById("slValues").value),
          stemUnit: Number.isInteger(stemUnit) && stemUnit > 0 ? stemUnit : 10
        }
      };
    }
    case "geometry-shapes": {
      const canvasWidth = Number.parseInt(document.getElementById("geoCanvasWidth").value, 10);
      const canvasHeight = Number.parseInt(document.getElementById("geoCanvasHeight").value, 10);
      const unit = String(document.getElementById("geoUnit").value || "unit").trim() || "unit";
      const formulaNotation = String(document.getElementById("geoFormulaNotation").value || "plain").trim() || "plain";
      return {
        type,
        config: {
          canvasWidth: Number.isInteger(canvasWidth) ? canvasWidth : 360,
          canvasHeight: Number.isInteger(canvasHeight) ? canvasHeight : 260,
          unit,
          formulaNotation,
          shapes: parseGeometryShapes(document.getElementById("geoShapesInput").value)
        }
      };
    }
    case "pythagoras":
      return {
        type,
        config: {
          sideA: document.getElementById("pySideA").value.trim(),
          sideB: document.getElementById("pySideB").value.trim(),
          sideC: document.getElementById("pySideC").value.trim(),
          caption: document.getElementById("pyCaption").value.trim()
        }
      };
    case "trigonometry": {
      const angleDeg = Number.parseFloat(document.getElementById("trigAngleDeg").value);
      return {
        type,
        config: {
          angleDeg: Number.isFinite(angleDeg) ? angleDeg : 35,
          focusFunction: document.getElementById("trigFunction").value || "sin",
          opposite: document.getElementById("trigOpposite").value.trim(),
          adjacent: document.getElementById("trigAdjacent").value.trim(),
          hypotenuse: document.getElementById("trigHypotenuse").value.trim()
        }
      };
    }
    default:
      return null;
  }
}

function populateInteractiveAppForm(app) {
  const typeSelect = document.getElementById("interactiveAppType");
  const nextApp = app || null;
  const type = nextApp ? (nextApp.type || "") : "";
  renderInteractiveAppTypeOptions(type);
  typeSelect.value = type;
  setInteractiveAppConfigVisibility(type);

  const numberLineConfig = (type === "number-line" ? nextApp : buildDefaultInteractiveApp("number-line")).config;
  document.getElementById("nlMin").value = numberLineConfig.min ?? -10;
  document.getElementById("nlMax").value = numberLineConfig.max ?? 10;
  document.getElementById("nlPoints").value = serializeNlPoints(numberLineConfig.points || []);
  document.getElementById("nlArrows").value = serializeNlArrows(numberLineConfig.arrows || []);

  const cartesianConfig = (type === "cartesian-plane" ? nextApp : buildDefaultInteractiveApp("cartesian-plane")).config;
  document.getElementById("cpXMin").value = cartesianConfig.xMin ?? -10;
  document.getElementById("cpXMax").value = cartesianConfig.xMax ?? 10;
  document.getElementById("cpYMin").value = cartesianConfig.yMin ?? -10;
  document.getElementById("cpYMax").value = cartesianConfig.yMax ?? 10;
  document.getElementById("cpAngleMode").value = cartesianConfig.angleMode === "degrees" ? "degrees" : "radians";
  document.getElementById("cpPoints").value = serializeCartesianPoints(cartesianConfig.points || []);
  document.getElementById("cpSegments").value = serializeCartesianSegments(cartesianConfig.segments || []);
  document.getElementById("cpParabolas").value = serializeCartesianParabolas(cartesianConfig.parabolas || []);
  document.getElementById("cpFunctions").value = serializeCartesianFunctions(cartesianConfig.functions || []);

  const cartesianPlotConfig = (type === "cartesian-plane-plot" ? nextApp : buildDefaultInteractiveApp("cartesian-plane-plot")).config;
  document.getElementById("cppXMin").value = cartesianPlotConfig.xMin ?? -10;
  document.getElementById("cppXMax").value = cartesianPlotConfig.xMax ?? 10;
  document.getElementById("cppYMin").value = cartesianPlotConfig.yMin ?? -10;
  document.getElementById("cppYMax").value = cartesianPlotConfig.yMax ?? 10;
  document.getElementById("cppTolerance").value = cartesianPlotConfig.tolerance ?? 0.5;
  document.getElementById("cppPoints").value = serializeCartesianPoints(cartesianPlotConfig.points || []);
  document.getElementById("cppVceTemplate").value = cartesianPlotConfig.vceTemplate || "";
  document.getElementById("cppPresetType").value = cartesianPlotConfig.presetType || "linear";
  document.getElementById("cppPresetExpression").value = cartesianPlotConfig.presetExpression || defaultCartesianPlotPresetExpression(cartesianPlotConfig.presetType || "linear");
  document.getElementById("cppPresetXValues").value = cartesianPlotConfig.presetXValues || defaultCartesianPlotPresetXValues(cartesianPlotConfig.presetType || "linear");

  const barChartConfig = (type === "bar-chart" ? nextApp : buildDefaultInteractiveApp("bar-chart")).config;
  document.getElementById("bcTitle").value = barChartConfig.title || "Category Frequencies";
  document.getElementById("bcYMax").value = Number.isFinite(Number(barChartConfig.yMax)) && Number(barChartConfig.yMax) > 0 ? String(barChartConfig.yMax) : "";
  document.getElementById("bcOrientation").value = String(barChartConfig.orientation || "vertical").trim().toLowerCase() === "horizontal" ? "horizontal" : "vertical";
  document.getElementById("bcCategoryAxisLabel").value = barChartConfig.categoryAxisLabel || "Category";
  document.getElementById("bcValueAxisLabel").value = barChartConfig.valueAxisLabel || "Value";
  document.getElementById("bcItems").value = serializeBarChartItems(barChartConfig.items || []);

  const histogramConfig = (type === "histogram" ? nextApp : buildDefaultInteractiveApp("histogram")).config;
  document.getElementById("histTitle").value = histogramConfig.title || "Continuous Data Distribution";
  document.getElementById("histValues").value = Array.isArray(histogramConfig.values) ? histogramConfig.values.join(", ") : "";
  document.getElementById("histBinCount").value = histogramConfig.binCount ?? 8;

  const boxPlotConfig = (type === "box-plot" ? nextApp : buildDefaultInteractiveApp("box-plot")).config;
  const boxDatasets = normalizeBoxPlotDatasets(boxPlotConfig);
  document.getElementById("boxTitle").value = boxPlotConfig.title || "Compare Datasets";
  document.getElementById("boxDatasetCount").value = String(clampBoxPlotDatasetCount(boxDatasets.length));
  document.getElementById("boxDatasets").value = serializeBoxPlotDatasets(boxDatasets);

  const scatterPlotConfig = (type === "scatter-plot" ? nextApp : buildDefaultInteractiveApp("scatter-plot")).config;
  document.getElementById("scTitle").value = scatterPlotConfig.title || "Correlation and Best Fit";
  document.getElementById("scPoints").value = serializeCartesianPoints(scatterPlotConfig.points || []);

  const probabilityConfig = (type === "probability-tree" ? nextApp : buildDefaultInteractiveApp("probability-tree")).config;
  document.getElementById("ptTitle").value = probabilityConfig.title || "Sequential Probabilities";
  document.getElementById("ptPaths").value = serializeProbabilityTreePaths(probabilityConfig.paths || []);
  document.getElementById("ptConditional").value = probabilityConfig.conditionalQuery || "";

  const distributionConfig = (type === "distribution-curve" ? nextApp : buildDefaultInteractiveApp("distribution-curve")).config;
  document.getElementById("dcTitle").value = distributionConfig.title || "Normal Distribution";
  document.getElementById("dcMean").value = distributionConfig.mean ?? 0;
  document.getElementById("dcStdDev").value = distributionConfig.stdDev ?? 1;
  document.getElementById("dcFrom").value = distributionConfig.from ?? -1;
  document.getElementById("dcTo").value = distributionConfig.to ?? 1;

  const fractionsConfig = (type === "fractions" ? nextApp : buildDefaultInteractiveApp("fractions")).config;
  document.getElementById("fxTitle").value = fractionsConfig.title || "Fraction Operations";
  document.getElementById("fxOperation").value = normalizeFractionOperation(fractionsConfig.operation);
  document.getElementById("fxNumeratorA").value = Number.isFinite(Number(fractionsConfig.fractionA && fractionsConfig.fractionA.numerator)) ? String(fractionsConfig.fractionA.numerator) : "1";
  document.getElementById("fxDenominatorA").value = Number.isFinite(Number(fractionsConfig.fractionA && fractionsConfig.fractionA.denominator)) && Number(fractionsConfig.fractionA.denominator) !== 0 ? String(fractionsConfig.fractionA.denominator) : "2";
  document.getElementById("fxNumeratorB").value = Number.isFinite(Number(fractionsConfig.fractionB && fractionsConfig.fractionB.numerator)) ? String(fractionsConfig.fractionB.numerator) : "1";
  document.getElementById("fxDenominatorB").value = Number.isFinite(Number(fractionsConfig.fractionB && fractionsConfig.fractionB.denominator)) && Number(fractionsConfig.fractionB.denominator) !== 0 ? String(fractionsConfig.fractionB.denominator) : "3";

  const networkConfig = (type === "network-graph" ? nextApp : buildDefaultInteractiveApp("network-graph")).config;
  document.getElementById("ngTitle").value = networkConfig.title || "Shortest Path, MST, Flow";
  document.getElementById("ngNodes").value = Array.isArray(networkConfig.nodes) ? networkConfig.nodes.join(", ") : "";
  document.getElementById("ngEdges").value = serializeNetworkEdges(networkConfig.edges || []);
  document.getElementById("ngSource").value = networkConfig.source || "";
  document.getElementById("ngTarget").value = networkConfig.target || "";
  document.getElementById("ngFlowSource").value = networkConfig.flowSource || "";
  document.getElementById("ngFlowSink").value = networkConfig.flowSink || "";

  const matrixConfig = (type === "matrix" ? nextApp : buildDefaultInteractiveApp("matrix")).config;
  document.getElementById("mxTitle").value = matrixConfig.title || "Matrix Operations";
  document.getElementById("mxOperation").value = normalizeMatrixOperation(matrixConfig.operation);
  document.getElementById("mxMatrixA").value = serializeMatrixRows(matrixConfig.matrixA || []);
  document.getElementById("mxMatrixB").value = serializeMatrixRows(matrixConfig.matrixB || []);

  const stemLeafConfig = (type === "stem-and-leaf" ? nextApp : buildDefaultInteractiveApp("stem-and-leaf")).config;
  document.getElementById("slValues").value = Array.isArray(stemLeafConfig.values) ? stemLeafConfig.values.join(", ") : "";
  document.getElementById("slStemUnit").value = stemLeafConfig.stemUnit ?? 10;

  const geometryConfig = (type === "geometry-shapes" ? nextApp : buildDefaultInteractiveApp("geometry-shapes")).config;
  document.getElementById("geoCanvasWidth").value = geometryConfig.canvasWidth ?? 360;
  document.getElementById("geoCanvasHeight").value = geometryConfig.canvasHeight ?? 260;
  document.getElementById("geoUnit").value = geometryConfig.unit || "unit";
  document.getElementById("geoFormulaNotation").value = geometryConfig.formulaNotation || "plain";
  document.getElementById("geoShapesInput").value = serializeGeometryShapes(geometryConfig.shapes || []);

  const pythagorasConfig = (type === "pythagoras" ? nextApp : buildDefaultInteractiveApp("pythagoras")).config;
  document.getElementById("pySideA").value = pythagorasConfig.sideA ?? "";
  document.getElementById("pySideB").value = pythagorasConfig.sideB ?? "";
  document.getElementById("pySideC").value = pythagorasConfig.sideC ?? "";
  document.getElementById("pyCaption").value = pythagorasConfig.caption ?? "";

  const trigonometryConfig = (type === "trigonometry" ? nextApp : buildDefaultInteractiveApp("trigonometry")).config;
  document.getElementById("trigAngleDeg").value = trigonometryConfig.angleDeg ?? 35;
  document.getElementById("trigFunction").value = trigonometryConfig.focusFunction || "sin";
  document.getElementById("trigOpposite").value = trigonometryConfig.opposite ?? "";
  document.getElementById("trigAdjacent").value = trigonometryConfig.adjacent ?? "";
  document.getElementById("trigHypotenuse").value = trigonometryConfig.hypotenuse ?? "";

  renderInteractiveAppPreview(nextApp);
}

// ── End Interactive App helpers ────────────────────────────────────────────

function refreshCorrectAnswerSelect(question) {
  const select = document.getElementById("correctAnswerSelect");
  const textInput = document.getElementById("correctAnswer");
  const checkboxWrap = document.getElementById("correctAnswerCheckboxWrap");
  const hint = document.getElementById("correctAnswerHint");
  const isCartesianPlotQuestion = Boolean(
    question
    && question.interactiveApp
    && question.interactiveApp.type === "cartesian-plane-plot"
  );

  if (isCartesianPlotQuestion) {
    select.style.display = "none";
    textInput.style.display = "none";
    checkboxWrap.style.display = "none";
    checkboxWrap.innerHTML = "";
    hint.textContent = "Not required for Cartesian Plane - Plot. Grading uses the Answer Points list.";
    return;
  }

  const resultType = question ? (question.resultType || "multiple-choice") : "multiple-choice";
  const choiceOptions = getChoiceOptions(question);

  const useSelect = ["multiple-choice", "true-false"].includes(resultType);
  const useCheckboxPicker = resultType === "checkbox";
  select.style.display = useSelect ? "block" : "none";
  textInput.style.display = (!useSelect && !useCheckboxPicker) ? "block" : "none";
  checkboxWrap.style.display = useCheckboxPicker ? "block" : "none";

  if (resultType === "short-answer") {
    hint.textContent = "Enter the expected answer text.";
  } else if (resultType === "plot") {
    hint.textContent = "Use this for plotting tasks. For Cartesian Plane - Plot, grading uses answer points.";
  } else if (resultType === "checkbox") {
    hint.textContent = "Choose one or more correct options.";
  } else {
    hint.textContent = "Choose the correct option from the list.";
  }

  if (useCheckboxPicker) {
    checkboxWrap.innerHTML = "";

    if (choiceOptions.length === 0) {
      checkboxWrap.innerHTML = "<p class='checkbox-answer-empty'>Add options to select correct answers.</p>";
      return;
    }

    const existingAnswers = String(question.correctAnswer || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .map(normalizeText);

    const list = document.createElement("div");
    list.className = "checkbox-answer-list";

    choiceOptions.forEach((optionText, index) => {
      const isSelected = existingAnswers.includes(normalizeText(optionText));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `checkbox-answer-item${isSelected ? " selected" : ""}`;
      btn.dataset.role = "correct-answer-check";
      btn.dataset.index = String(index);
      btn.dataset.value = optionText;
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      btn.textContent = optionText;
      btn.addEventListener("click", () => {
        const pressed = btn.getAttribute("aria-pressed") === "true";
        btn.setAttribute("aria-pressed", pressed ? "false" : "true");
        btn.classList.toggle("selected", !pressed);
        updateQuestionFromForm();
      });
      list.appendChild(btn);
    });

    checkboxWrap.appendChild(list);
  }

  if (!useSelect) {
    return;
  }

  select.innerHTML = "";
  if (choiceOptions.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No options available";
    select.appendChild(option);
    select.value = "";
    return;
  }

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select correct option";
  select.appendChild(placeholder);

  choiceOptions.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = item;
    select.appendChild(option);
  });

  const selectedIndex = choiceOptions.findIndex((item) => normalizeText(item) === normalizeText(question.correctAnswer));
  select.value = selectedIndex >= 0 ? String(selectedIndex) : "";
}

function updateNotesPreview(attachments) {
  const button = document.getElementById("notesBtn");
  const preview = document.getElementById("notesPreview");
  const list = Array.isArray(attachments) ? attachments : [];
  if (list.length === 0) {
    button.textContent = "Notes: N/A";
    preview.textContent = "n/a";
    return;
  }

  const parts = splitNotesAttachments(list);
  const chunks = [];
  if (parts.youtube) {
    chunks.push("YouTube: attached");
  }
  if (parts.pdf.length > 0) {
    const embeddedCount = parts.pdf.filter((item) => item.startsWith("data:")).length;
    const linkedCount = parts.pdf.length - embeddedCount;
    if (embeddedCount > 0) {
      chunks.push(`PDF embedded: ${embeddedCount}`);
    }
    if (linkedCount > 0) {
      chunks.push(`PDF linked: ${linkedCount}`);
    }
  }
  if (parts.other.length > 0) {
    chunks.push(`Other links: ${parts.other.length}`);
  }

  button.textContent = `Notes: ${list.length} attachment(s)`;
  preview.textContent = chunks.join(" | ") || "n/a";
}

function updateSolutionAttachmentsPreview(attachments) {
  const button = document.getElementById("solutionAssetsBtn");
  const preview = document.getElementById("solutionAttachmentsPreview");
  const normalized = normalizeSolutionAttachments(attachments);
  if (normalized.length === 0) {
    button.textContent = "Solution Files: N/A";
    preview.textContent = "n/a";
    return;
  }

  button.textContent = `Solution Files: ${normalized.length} attachment(s)`;
  preview.textContent = normalized.map((item) => item.name).join(" | ");
}

function renderEditor() {
  const hint = document.getElementById("editorHint");
  const editorContent = document.getElementById("questionEditorContent");
  const editorEmptyState = document.getElementById("questionEditorEmptyState");
  const question = activeQuestion();
  const quiz = activeQuiz();
  const attachImageBtn = document.getElementById("attachImageBtn");
  const imageAttachHint = document.getElementById("imageAttachHint");
  const attachSolutionFileBtn = document.getElementById("attachSolutionFileBtn");
  const solutionAttachHint = document.getElementById("solutionAttachHint");
  const attachNotesPdfBtn = document.getElementById("attachNotesPdfBtn");
  const notesPdfHint = document.getElementById("notesPdfHint");

  if (editorContent) {
    editorContent.classList.toggle("hidden", !quiz);
  }
  if (editorEmptyState) {
    editorEmptyState.classList.toggle("hidden", Boolean(quiz));
    editorEmptyState.textContent = quiz
      ? ""
      : "Select or create a category and quiz to edit questions.";
  }

  if (!question) {
    hint.textContent = quiz ? "Preparing question editor..." : "Select a question to edit details.";
    document.getElementById("questionText").value = "";
    document.getElementById("resultType").value = "multiple-choice";
    document.getElementById("option1").value = "";
    document.getElementById("option2").value = "";
    document.getElementById("option3").value = "";
    document.getElementById("option4").value = "";
    document.getElementById("correctAnswer").value = "";
    document.getElementById("correctAnswerSelect").innerHTML = "";
    document.getElementById("correctAnswerCheckboxWrap").innerHTML = "";
    document.getElementById("attachmentsInput").value = "";
    document.getElementById("notesYoutubeInput").value = "";
    document.getElementById("notesPdfUrlsInput").value = "";
    document.getElementById("questionImage").value = "";
    document.getElementById("solutionText").value = "";
    document.getElementById("solutionAttachmentsInput").value = "";
    updateImagePreview("");
    attachImageBtn.disabled = true;
    attachSolutionFileBtn.disabled = true;
    attachNotesPdfBtn.disabled = true;
    imageAttachHint.textContent = "Select a question first to attach an image.";
    solutionAttachHint.textContent = "Select a question first to attach solution files.";
    notesPdfHint.textContent = "Select a question first to attach notes PDF.";
    updateNotesPreview([]);
    updateSolutionAttachmentsPreview([]);
    toggleOptionsBlock({ resultType: "multiple-choice" });
    refreshCorrectAnswerSelect({ resultType: "multiple-choice", options: ["", "", "", ""], correctAnswer: "" });
    renderValidationBox(null);
    populateInteractiveAppForm(null);
    return;
  }

  hint.textContent = `Editing question ${state.selectedQuestionIndex + 1}`;
  ensureTrueFalseOptions(question);
  document.getElementById("questionText").value = question.question || "";
  document.getElementById("resultType").value = question.resultType || "multiple-choice";
  document.getElementById("option1").value = question.options[0] || "";
  document.getElementById("option2").value = question.options[1] || "";
  document.getElementById("option3").value = question.options[2] || "";
  document.getElementById("option4").value = question.options[3] || "";
  document.getElementById("correctAnswer").value = question.correctAnswer || "";
  document.getElementById("correctAnswerSelect").innerHTML = "";
  document.getElementById("correctAnswerCheckboxWrap").innerHTML = "";
  const notesParts = splitNotesAttachments(question.notesAttachments || []);
  document.getElementById("attachmentsInput").value = serializeManualNotesAttachments(question.notesAttachments || []);
  document.getElementById("notesYoutubeInput").value = notesParts.youtube;
  document.getElementById("notesPdfUrlsInput").value = notesParts.pdf.filter((item) => !item.startsWith("data:")).join("\n");
  document.getElementById("questionImage").value = question.image || "";
  document.getElementById("solutionText").value = question.solution || "";
  document.getElementById("solutionAttachmentsInput").value = serializeManualSolutionAttachments(question.solutionAttachments || []);
  updateImagePreview(question.image || "");
  attachImageBtn.disabled = false;
  attachSolutionFileBtn.disabled = false;
  attachNotesPdfBtn.disabled = false;
  imageAttachHint.textContent = "Attach image for the selected question, or paste a URL above.";
  solutionAttachHint.textContent = "Add links above, or attach local files to embed them in the quiz JSON.";
  notesPdfHint.textContent = notesParts.pdf.length > 0
    ? `${notesParts.pdf.length} PDF attachment(s) for this question.`
    : "Paste PDF URLs above or attach PDF files to embed them in quiz JSON.";
  updateNotesPreview(question.notesAttachments || []);
  updateSolutionAttachmentsPreview(question.solutionAttachments || []);
  toggleOptionsBlock(question);
  refreshCorrectAnswerSelect(question);
  renderValidationBox(question);
  populateInteractiveAppForm(question.interactiveApp || null);
}

function getQuizData() {
  const selectedQuiz = activeQuiz();
  const category = activeCategory();
  const selectedQuestions = selectedQuiz
    ? selectedQuiz.questions.map((item) => {
      const q = {
        question: item.question || "",
        resultType: item.resultType || "multiple-choice",
        options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
        correctAnswer: item.correctAnswer || "",
        notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
        image: item.image || "",
        solution: item.solution || "",
        solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments)
      };
      if (item.interactiveApp) q.interactiveApp = item.interactiveApp;
      return q;
    })
    : [];

  return {
    id: selectedQuiz ? selectedQuiz.id : "",
    title: selectedQuiz ? selectedQuiz.title : "Untitled Quiz",
    description: selectedQuiz ? normalizeQuizDescription(selectedQuiz.description) : "",
    settings: selectedQuiz ? normalizeQuizSettings(selectedQuiz.settings) : normalizeQuizSettings(null),
    fileName: selectedQuiz ? getSelectedQuizFileName() : "quiz.json",
    sourcePath: selectedQuiz ? (selectedQuiz.sourcePath || "") : "",
    category: category ? category.name : "General",
    questions: selectedQuestions
  };
}

function updateGeneratedJson() {
  document.getElementById("generatedJson").value = JSON.stringify(getQuizData(), null, 2);
  document.getElementById("quizFileName").value = getSelectedQuizFileName();

  const rootInput = document.getElementById("quizRootFolder");
  if (rootInput) {
    rootInput.value = state.rootFolder;
  }

  const rootSourceModeInput = document.getElementById("rootSourceMode");
  if (rootSourceModeInput) {
    rootSourceModeInput.value = normalizeRootSourceMode(state.rootSourceMode);
  }
}

function renderAll() {
  ensureSelection();
  renderCategoryList();
  renderQuizList();
  renderQuestionsList();
  renderEditor();
  updateGeneratedJson();
  updateEmbedOutputForActiveQuiz();
  saveDraft();
}

async function addCategory() {
  const name = prompt("Category name:", `Category ${state.categories.length + 1}`);
  if (!name || !name.trim()) return;

  const category = createCategory(name.trim());
  const quiz = createQuiz("New Quiz");
  quiz.questions.push(createEmptyQuestion());
  category.quizzes.push(quiz);
  state.categories.push(category);
  state.selectedCategoryId = category.id;
  state.selectedQuizId = category.quizzes[0].id;
  state.selectedQuestionIndex = 0;
  renderAll();

  await createCategoryFolderOnDisk(category);
  await createStarterQuizFileOnDisk(category, quiz);
  renderAll();
}

async function addQuiz() {
  const category = activeCategory();
  if (!category) {
    showToast("Create a category first.", "warning");
    return;
  }

  const title = prompt("Quiz title:", `Quiz ${category.quizzes.length + 1}`);
  if (!title || !title.trim()) return;

  const quiz = createQuiz(title.trim());
  ensureQuizHasDefaultQuestion(quiz);
  category.quizzes.push(quiz);
  state.selectedQuizId = quiz.id;
  state.selectedQuestionIndex = 0;
  renderAll();

  await createCategoryFolderOnDisk(category);
  await createStarterQuizFileOnDisk(category, quiz);
  renderAll();
}

function replicateQuiz(id) {
  const category = activeCategory();
  if (!category) return;

  const sourceIndex = category.quizzes.findIndex((item) => item.id === id);
  if (sourceIndex === -1) return;
  const source = category.quizzes[sourceIndex];

  const newId = `quiz-${quizSeed++}`;
  const newTitle = source.title + " (Copy)";
  const newFileName = buildUniqueQuizFileName(newTitle, newId);

  const copy = {
    id: newId,
    title: newTitle,
    description: source.description || "",
    settings: JSON.parse(JSON.stringify(source.settings || normalizeQuizSettings(null))),
    fileName: newFileName,
    sourcePath: "",
    questions: JSON.parse(JSON.stringify(source.questions || []))
  };

  category.quizzes.splice(sourceIndex + 1, 0, copy);
  state.selectedQuizId = newId;

  renderAll();
  showToast(`Quiz replicated as "${newTitle}".`, "success");
}

function openQuizSettingsModal(quizId = state.selectedQuizId) {
  const category = activeCategory();
  if (!category) {
    showToast("Select a category first.", "warning");
    return;
  }

  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) {
    showToast("Select a quiz first.", "warning");
    return;
  }

  const modal = document.getElementById("quizSettingsModal");
  if (!(modal instanceof HTMLElement)) return;

  modal.dataset.quizId = quiz.id;
  document.getElementById("quizSettingsTitle").value = quiz.title || "";
  document.getElementById("quizSettingsDescription").value = normalizeQuizDescription(quiz.description);

  const normalizedSettings = normalizeQuizSettings(quiz.settings);
  document.getElementById("quizSettingsOrder").value = normalizedSettings.questionOrder;
  document.getElementById("quizSettingsLimit").value = normalizedSettings.questionLimit ? String(normalizedSettings.questionLimit) : "";

  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeQuizSettingsModal() {
  const modal = document.getElementById("quizSettingsModal");
  if (!(modal instanceof HTMLElement)) return;
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
  modal.dataset.quizId = "";
  document.body.classList.remove("modal-open");
}

function saveQuizSettingsFromModal() {
  const modal = document.getElementById("quizSettingsModal");
  if (!(modal instanceof HTMLElement)) return;

  const quizId = String(modal.dataset.quizId || "");
  if (!quizId) return;

  const category = activeCategory();
  if (!category) return;

  const quiz = category.quizzes.find((item) => item.id === quizId);
  if (!quiz) return;

  const nextTitleRaw = document.getElementById("quizSettingsTitle").value.trim();
  if (!nextTitleRaw) {
    showToast("Quiz name is required.", "warning");
    return;
  }

  quiz.title = nextTitleRaw;
  quiz.description = normalizeQuizDescription(document.getElementById("quizSettingsDescription").value);
  quiz.settings = normalizeQuizSettings({
    questionOrder: document.getElementById("quizSettingsOrder").value,
    questionLimit: document.getElementById("quizSettingsLimit").value
  });

  renderAll();
  closeQuizSettingsModal();
  showToast("Quiz settings saved.", "success");
}

async function addQuestion() {
  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Create a quiz first.", "warning");
    return;
  }

  quiz.questions.push(createEmptyQuestion());
  state.selectedQuestionIndex = quiz.questions.length - 1;
  renderAll();
  await persistSelectedQuizAfterMutation("Question list");
}

function requireDeletePhrase(scopeLabel) {
  const typed = prompt(`To delete this ${scopeLabel}, type DELETE in uppercase:`);
  if (typed === "DELETE") {
    return true;
  }

  if (typed === null) {
    showToast("Delete canceled.", "info");
  } else {
    showToast("Delete blocked. Type DELETE exactly.", "warning");
  }

  return false;
}

async function deleteCategory(id) {
  if (!requireDeletePhrase("category")) return;

  const index = state.categories.findIndex((item) => item.id === id);
  if (index === -1) return;
  const category = state.categories[index];
  state.categories.splice(index, 1);
  showToast("Category deleted.", "info");
  renderAll();

  await deleteCategoryFolderFromDisk(category);
}

async function deleteQuizFileFromDisk(quiz, category) {
  if (normalizeRootSourceMode(state.rootSourceMode) !== ROOT_SOURCE_MODES.LOCAL) {
    return;
  }

  if (!supportsFolderDeletion()) {
    showToast("Quiz removed in app. Browser cannot auto-delete local files here.", "warning");
    return;
  }

  if (!quiz || !category) {
    return;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: false, allowPrompt: false });
    if (!configuredRoot) {
      showToast("Quiz removed. Connect root folder to delete file on disk.", "warning");
      return;
    }

    const relativePath = await resolveWritableQuizRelativePath(configuredRoot, quiz, category);
    const parts = String(relativePath || "").split("/").filter((item) => item !== "");
    if (parts.length < 2) {
      showToast("Quiz removed. Could not resolve quiz file path on disk.", "warning");
      return;
    }

    const fileName = parts.pop();
    let directoryHandle = configuredRoot;
    for (const segment of parts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: false });
    }

    await directoryHandle.removeEntry(fileName);
    showToast(`Quiz file deleted: ${relativePath}`, "success");
  } catch (error) {
    if (error && error.name === "NotFoundError") {
      showToast("Quiz removed. File not found on disk.", "info");
      return;
    }

    if (error && error.name === "AbortError") {
      showToast("Quiz removed. File delete canceled.", "info");
      return;
    }

    showToast("Quiz removed. Could not delete quiz file on disk.", "warning");
  }
}

async function deleteQuiz(id) {
  if (!requireDeletePhrase("quiz")) return;

  const category = activeCategory();
  if (!category) return;
  const index = category.quizzes.findIndex((item) => item.id === id);
  if (index === -1) return;
  const quiz = category.quizzes[index];
  category.quizzes.splice(index, 1);
  showToast("Quiz deleted.", "info");
  renderAll();

  await deleteQuizFileFromDisk(quiz, category);
}

async function deleteQuestion(index) {
  const quiz = activeQuiz();
  if (!quiz || index < 0 || index >= quiz.questions.length) return;
  quiz.questions.splice(index, 1);
  renderAll();
  await persistSelectedQuizAfterMutation("Question list");
}

function scheduleSilentDiskSave(delayMs = 700) {
  if (normalizeRootSourceMode(state.rootSourceMode) !== ROOT_SOURCE_MODES.LOCAL) {
    return;
  }
  if (!supportsFolderDeletion()) {
    return;
  }

  if (silentSaveTimer) {
    window.clearTimeout(silentSaveTimer);
  }

  silentSaveTimer = window.setTimeout(async () => {
    silentSaveTimer = null;
    await writeSelectedQuizToDisk({ allowPrompt: false, notify: false });
  }, Math.max(100, Number(delayMs) || 700));
}

function updateQuestionFromForm() {
  const question = activeQuestion();
  if (!question) return;

  const previousNotesParts = splitNotesAttachments(question.notesAttachments || []);

  question.question = document.getElementById("questionText").value.trim();
  question.resultType = normalizeResultType(document.getElementById("resultType").value);
  question.options = [
    document.getElementById("option1").value.trim(),
    document.getElementById("option2").value.trim(),
    document.getElementById("option3").value.trim(),
    document.getElementById("option4").value.trim()
  ];

  if (question.resultType === "true-false") {
    ensureTrueFalseOptions(question);
  }

  if (["multiple-choice", "true-false"].includes(question.resultType)) {
    const select = document.getElementById("correctAnswerSelect");
    const selectedIndexFromUi = Number.parseInt(select.value, 10);

    ensureDefaultCorrectAnswer(question);
    const choiceOptions = getChoiceOptions(question);
    if (Number.isInteger(selectedIndexFromUi) && selectedIndexFromUi >= 0 && selectedIndexFromUi < choiceOptions.length) {
      question.correctAnswer = choiceOptions[selectedIndexFromUi];
    } else {
      const existingIndex = choiceOptions.findIndex((item) => normalizeText(item) === normalizeText(question.correctAnswer));
      question.correctAnswer = existingIndex >= 0 ? choiceOptions[existingIndex] : "";
    }
  } else if (question.resultType === "checkbox") {
    const choiceOptions = getChoiceOptions(question);
    const currentChecked = Array.from(document.querySelectorAll("button[data-role='correct-answer-check'][aria-pressed='true']"))
      .map((item) => String(item.dataset.value || "").trim())
      .filter((item) => item !== "");
    const fallbackChecked = String(question.correctAnswer || "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "")
      .filter((answer) => choiceOptions.some((option) => normalizeText(option) === normalizeText(answer)));
    const nextChecked = currentChecked.length > 0 ? currentChecked : fallbackChecked;
    question.correctAnswer = nextChecked.join(", ");
  } else {
    question.correctAnswer = document.getElementById("correctAnswer").value.trim();
  }

  refreshCorrectAnswerSelect(question);

  const manualNoteLinks = document.getElementById("attachmentsInput").value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const manualParts = splitNotesAttachments(manualNoteLinks);
  const youtubeFromField = normalizeYoutubeUrl(document.getElementById("notesYoutubeInput").value);
  const pdfFromField = parsePdfUrlLines(document.getElementById("notesPdfUrlsInput").value);
  const previousEmbeddedPdf = previousNotesParts.pdf.filter((item) => item.startsWith("data:"));
  const nextNotesParts = {
    youtube: youtubeFromField || manualParts.youtube,
    pdf: mergeUniqueNotesAttachments([...pdfFromField, ...manualParts.pdf, ...previousEmbeddedPdf]),
    other: manualParts.other
  };
  question.notesAttachments = buildNotesAttachments(nextNotesParts);
  document.getElementById("attachmentsInput").value = nextNotesParts.other.join("\n");
  document.getElementById("notesYoutubeInput").value = nextNotesParts.youtube;
  document.getElementById("notesPdfUrlsInput").value = nextNotesParts.pdf.filter((item) => !item.startsWith("data:")).join("\n");
  question.image = document.getElementById("questionImage").value.trim();
  question.solution = document.getElementById("solutionText").value.trim();
  question.solutionAttachments = [
    ...parseSolutionAttachmentLines(document.getElementById("solutionAttachmentsInput").value),
    ...normalizeSolutionAttachments(question.solutionAttachments).filter((item) => item.embedded)
  ];
  question.interactiveApp = readInteractiveAppFromForm();

  toggleOptionsBlock(question);
  updateNotesPreview(question.notesAttachments);
  updateSolutionAttachmentsPreview(question.solutionAttachments);
  updateImagePreview(question.image);
  renderInteractiveAppPreview(question.interactiveApp);
  renderQuestionsList();
  renderValidationBox(question);
  updateGeneratedJson();
  saveDraft();
  scheduleSilentDiskSave();
}

function updateImagePreview(src) {
  const preview = document.getElementById("questionImagePreview");
  if (!preview) return;
  if (src) {
    preview.src = src;
    preview.classList.remove("hidden");
  } else {
    preview.src = "";
    preview.classList.add("hidden");
  }
}

function buildPersistedQuizPayload() {
  const selectedQuiz = activeQuiz();
  const category = activeCategory();
  if (!selectedQuiz || !category) {
    return null;
  }

  return {
    id: selectedQuiz.id || slugify(selectedQuiz.title || "quiz"),
    title: selectedQuiz.title || "Untitled Quiz",
    description: normalizeQuizDescription(selectedQuiz.description),
    settings: normalizeQuizSettings(selectedQuiz.settings),
    category: category.name || "General",
    questions: (selectedQuiz.questions || []).map((item) => {
      const question = {
        question: item.question || "",
        resultType: item.resultType || "multiple-choice",
        options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
        correctAnswer: item.correctAnswer || "",
        notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
        image: item.image || "",
        solution: item.solution || "",
        solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments)
      };

      if (item.interactiveApp) {
        question.interactiveApp = item.interactiveApp;
      }

      return question;
    })
  };
}

function resolveQuizRelativePath(quiz, category) {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  const rawSourcePath = String(quiz.sourcePath || "").replace(/\\/g, "/");
  if (rawSourcePath) {
    const rootPrefix = `${rootFolder}/`;
    if (rawSourcePath.startsWith(rootPrefix)) {
      return rawSourcePath.slice(rootPrefix.length);
    }

    if (!rawSourcePath.includes("/")) {
      return `${slugify(category.name || "category")}/${rawSourcePath}`;
    }

    return rawSourcePath;
  }

  return `${slugify(category.name || "category")}/${normalizeQuizFileName(quiz.fileName || quiz.title || "quiz")}`;
}

async function writeSelectedQuizToDisk(options = {}) {
  const { allowPrompt = true, notify = true } = options;
  const quiz = activeQuiz();
  const category = activeCategory();
  const payload = buildPersistedQuizPayload();
  if (!quiz || !category || !payload) {
    if (notify) {
      showToast("Select a quiz first.", "warning");
    }
    return false;
  }

  if (!supportsFolderDeletion()) {
    return false;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({
      create: true,
      allowPrompt,
      promptForPermission: allowPrompt
    });
    if (!configuredRoot) {
      return false;
    }
    const relativePath = await resolveWritableQuizRelativePath(configuredRoot, quiz, category);
    const parts = relativePath.split("/").filter((item) => item !== "");
    if (parts.length === 0) {
      if (notify) {
        showToast("Could not resolve save path.", "error");
      }
      return false;
    }

    const fileName = parts.pop();
    if (!fileName || !fileName.toLowerCase().endsWith(".json")) {
      if (notify) {
        showToast("Quiz file name must end with .json", "warning");
      }
      return false;
    }

    let directoryHandle = configuredRoot;
    for (const segment of parts) {
      directoryHandle = await directoryHandle.getDirectoryHandle(segment, { create: true });
    }

    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(`${JSON.stringify(payload, null, 2)}\n`);
    await writable.close();

    quiz.fileName = normalizeQuizFileName(fileName);

    const normalizedRoot = normalizeRootFolder(state.rootFolder);
    const savedRelative = [...parts, fileName].join("/");
    quiz.sourcePath = savedRelative.startsWith(`${normalizedRoot}/`)
      ? savedRelative
      : `${normalizedRoot}/${savedRelative}`;

    updateGeneratedJson();
    saveDraft();
    if (notify) {
      showToast(`Saved ${[...parts, fileName].join("/")}`, "success");
    }
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") {
      if (notify) {
        showToast("Save canceled.", "info");
      }
      return false;
    }

    if (notify) {
      showToast("Could not save to local folder.", "warning");
    }
    return false;
  }
}

async function persistSelectedQuizAfterMutation(scopeLabel = "Quiz") {
  const saved = await writeSelectedQuizToDisk({ allowPrompt: false, notify: false });
  if (!saved) {
    showToast(`${scopeLabel} updated in Maker but not saved to file. Click Save Quiz or Connect Root Folder.`, "warning");
  }
  return saved;
}

function downloadSelectedQuizJson() {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
  const json = JSON.stringify(getQuizData(), null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = getSelectedQuizFileName();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

async function saveSelectedQuiz(options = {}) {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
  const { allowPrompt = true } = options;
  const saved = await writeSelectedQuizToDisk({ allowPrompt, notify: true });
  if (!saved) {
    showToast(
      allowPrompt
        ? "Save failed. Use Connect Root Folder and try again."
        : "Save failed. Connect Root Folder first, then try again.",
      "warning"
    );
  }

  return saved;
}

function moveQuestion(fromIndex, toIndex) {
  const quiz = activeQuiz();
  if (!quiz) return;
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || toIndex < 0) return;
  if (fromIndex >= quiz.questions.length || toIndex >= quiz.questions.length) return;

  const [moved] = quiz.questions.splice(fromIndex, 1);
  quiz.questions.splice(toIndex, 0, moved);
  state.selectedQuestionIndex = toIndex;
  renderAll();
}

function attachImageToQuestion(file) {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first. Image attaches to the active question only.", "warning");
    return;
  }

  if (!file) {
    return;
  }

  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file.", "warning");
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = typeof reader.result === "string" ? reader.result : "";
    if (!dataUrl) {
      showToast("Could not read image file.", "error");
      return;
    }

    document.getElementById("questionImage").value = dataUrl;
    updateQuestionFromForm();
    showToast("Image attached to question.", "success");
  };

  reader.onerror = () => {
    showToast("Could not read image file.", "error");
  };

  reader.readAsDataURL(file);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) {
        reject(new Error("Could not read file."));
        return;
      }
      resolve(dataUrl);
    };
    reader.onerror = () => reject(new Error("Could not read file."));
    reader.readAsDataURL(file);
  });
}

async function attachSolutionFilesToQuestion(fileList) {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return;
  }

  updateQuestionFromForm();

  try {
    const embeddedAttachments = await Promise.all(files.map(async (file) => ({
      name: file.name || "Attachment",
      url: await readFileAsDataUrl(file),
      embedded: true
    })));
    question.solutionAttachments = [
      ...normalizeSolutionAttachments(question.solutionAttachments),
      ...embeddedAttachments
    ];
    renderEditor();
    updateGeneratedJson();
    saveDraft();
    showToast(`Attached ${embeddedAttachments.length} solution file(s).`, "success");
  } catch (error) {
    showToast("Could not read solution file.", "error");
  }
}

async function attachNotesPdfToQuestion(fileList) {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const files = Array.from(fileList || []);
  if (files.length === 0) {
    return;
  }

  const hasInvalidFile = files.some((file) => !/application\/pdf/i.test(file.type) && !/\.pdf$/i.test(file.name || ""));
  if (hasInvalidFile) {
    showToast("Please select PDF files only.", "warning");
    return;
  }

  updateQuestionFromForm();

  try {
    const pdfDataUrls = await Promise.all(files.map((file) => readFileAsDataUrl(file)));
    const parts = splitNotesAttachments(question.notesAttachments || []);
    parts.pdf = mergeUniqueNotesAttachments([...parts.pdf, ...pdfDataUrls]);
    question.notesAttachments = buildNotesAttachments(parts);
    renderEditor();
    updateGeneratedJson();
    saveDraft();
    showToast(`Attached ${pdfDataUrls.length} notes PDF file(s).`, "success");
  } catch (error) {
    showToast("Could not read one or more PDF files.", "error");
  }
}

function setSolutionPanelCollapsed(collapsed) {
  const body = document.getElementById("solutionPanelBody");
  const button = document.getElementById("toggleSolutionPanelBtn");
  if (!(body instanceof HTMLElement) || !(button instanceof HTMLButtonElement)) {
    return;
  }

  body.classList.toggle("hidden", collapsed);
  button.textContent = collapsed ? "Expand" : "Collapse";
  button.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

document.getElementById("addCategoryBtn").addEventListener("click", addCategory);
document.getElementById("addQuizBtn").addEventListener("click", addQuiz);
document.getElementById("openQuizSettingsBtn").addEventListener("click", () => {
  openQuizSettingsModal();
});
document.getElementById("addQuestionBtn").addEventListener("click", addQuestion);

document.getElementById("categorySearch").addEventListener("input", renderCategoryList);
document.getElementById("quizSearch").addEventListener("input", renderQuizList);
document.getElementById("questionSearch").addEventListener("input", renderQuestionsList);
document.getElementById("attachImageBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("imageFileInput").click();
});

document.getElementById("attachSolutionFileBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("solutionFileInput").click();
});

document.getElementById("attachNotesPdfBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("notesPdfInput").click();
});

document.getElementById("imageFileInput").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files && target.files[0];
  attachImageToQuestion(file || null);
  target.value = "";
});

document.getElementById("solutionFileInput").addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  await attachSolutionFilesToQuestion(target.files);
  target.value = "";
});

document.getElementById("notesPdfInput").addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  await attachNotesPdfToQuestion(target.files);
  target.value = "";
});

document.getElementById("categoryList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const id = target.dataset.id;
  if (!id) return;

  if (target.dataset.action === "delete") {
    deleteCategory(id);
    return;
  }

  state.selectedCategoryId = id;
  state.selectedQuizId = null;
  state.selectedQuestionIndex = -1;
  renderAll();
});

document.getElementById("quizList").addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const id = target.dataset.id;
  if (!id) return;

  if (target.dataset.action === "delete") {
    await deleteQuiz(id);
    return;
  }

  if (target.dataset.action === "replicate") {
    replicateQuiz(id);
    return;
  }

  if (target.dataset.action === "settings") {
    openQuizSettingsModal(id);
    return;
  }

  if (target.dataset.action === "auto") {
    autoCreateEntireQuiz(id);
    return;
  }

  state.selectedQuizId = id;
  state.selectedQuestionIndex = -1;
  const quiz = activeQuiz();
  if (ensureQuizHasDefaultQuestion(quiz)) {
    state.selectedQuestionIndex = 0;
  }
  renderAll();
});

document.getElementById("questionsList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const indexValue = target.dataset.index;
  if (typeof indexValue === "undefined") return;
  const index = Number.parseInt(indexValue, 10);
  if (Number.isNaN(index)) return;

  if (target.dataset.action === "delete") {
    void deleteQuestion(index);
    return;
  }

  state.selectedQuestionIndex = index;
  renderAll();
});

document.getElementById("questionsList").addEventListener("dragstart", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  const dragIndex = Number.parseInt(row.dataset.dragIndex || "-1", 10);
  if (Number.isNaN(dragIndex) || dragIndex < 0) return;
  state.draggingQuestionIndex = dragIndex;
  row.classList.add("dragging");
});

document.getElementById("questionsList").addEventListener("dragover", (event) => {
  event.preventDefault();
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  document.querySelectorAll("#questionsList .list-item").forEach((item) => item.classList.remove("drag-over"));
  row.classList.add("drag-over");
});

document.getElementById("questionsList").addEventListener("dragleave", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;
  row.classList.remove("drag-over");
});

document.getElementById("questionsList").addEventListener("drop", (event) => {
  event.preventDefault();
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest(".list-item");
  if (!(row instanceof HTMLElement)) return;

  const targetIndex = Number.parseInt(row.dataset.dragIndex || "-1", 10);
  if (Number.isNaN(targetIndex) || targetIndex < 0) return;

  moveQuestion(state.draggingQuestionIndex, targetIndex);
  state.draggingQuestionIndex = -1;
});

document.getElementById("questionsList").addEventListener("dragend", () => {
  state.draggingQuestionIndex = -1;
  document.querySelectorAll("#questionsList .list-item").forEach((item) => {
    item.classList.remove("dragging");
    item.classList.remove("drag-over");
  });
});

document.getElementById("notesBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question || !question.notesAttachments || question.notesAttachments.length === 0) {
    showToast("No notes attachments.", "info");
    return;
  }

  showToast(`Attachments: ${question.notesAttachments.length}`, "success");
});

document.getElementById("saveQuestionBtn").addEventListener("click", async () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  updateQuestionFromForm();
  const saved = await saveSelectedQuiz({ allowPrompt: false });
  if (saved) {
    showToast("Question changes saved.", "success");
    return;
  }

  showToast("Question updated in Maker, but file save did not run. Connect Root Folder if needed.", "warning");
});

document.getElementById("autoCreateQuestionBtn").addEventListener("click", async () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  const category = String(document.getElementById("autoCreateCategory").value || "cartesian-plane").trim();
  const subcategory = String(document.getElementById("autoCreateSubcategory").value || "linear").trim();
  const difficulty = String(document.getElementById("autoCreateDifficulty").value || "easy").trim();
  const resultTypeChoice = String(document.getElementById("autoCreateResultType").value || "auto").trim();
  const commandWord = String(document.getElementById("autoCreateCommandWord").value || "determine").trim();
  const answerPolicy = String(document.getElementById("autoCreateAnswerFormat").value || "auto").trim();
  const decimalPlaces = Number.parseInt(document.getElementById("autoCreateDecimalPlaces").value, 10);
  const domainMinRaw = document.getElementById("autoCreateDomainMin").value;
  const domainMaxRaw = document.getElementById("autoCreateDomainMax").value;
  const domainMin = domainMinRaw === "" ? null : Number.parseFloat(domainMinRaw);
  const domainMax = domainMaxRaw === "" ? null : Number.parseFloat(domainMaxRaw);

  const generationOptions = {
    commandWord,
    answerPolicy,
    decimalPlaces: Number.isInteger(decimalPlaces) ? decimalPlaces : 2,
    domainMin,
    domainMax
  };

  const payload = buildAutoPayloadForCategory(category, subcategory, difficulty, resultTypeChoice, generationOptions);
  if (!payload) {
    showToast("Could not generate this question for the selected category. Try a different subcategory or difficulty.", "warning");
    return;
  }

  const verification = verifyAutoPayload(category, subcategory, payload);
  if (!verification.ok) {
    const summary = verification.issues.slice(0, 2).join(" | ");
    showToast(`Auto Create verification failed: ${summary}`, "warning");
    return;
  }

  applyAutoCreatedQuestionToEditor(payload);
  updateQuestionFromForm();
  await persistSelectedQuizAfterMutation("Auto-created question");
  showToast("Question auto-created and semantically verified.", "success");
});

document.getElementById("autoCreateQuizBtn").addEventListener("click", () => {
  void autoCreateEntireQuiz();
});

document.getElementById("autoCreateCategory").addEventListener("change", () => {
  populateAutoCreateSubcategoryOptions();
  updateAutoCreateCommandWordControl();
});

document.getElementById("validateGeneratedQuestionBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }
  updateQuestionFromForm();
  const issues = getQuestionValidationIssues(question);
  if (issues.length === 0) {
    showToast("Validation passed.", "success");
    return;
  }
  showToast(`Validation found ${issues.length} issue(s).`, "warning");
});

["questionText", "resultType", "option1", "option2", "option3", "option4", "correctAnswer", "attachmentsInput", "notesYoutubeInput", "notesPdfUrlsInput", "questionImage", "solutionText", "solutionAttachmentsInput", "nlMin", "nlMax", "nlPoints", "nlArrows", "cpXMin", "cpXMax", "cpYMin", "cpYMax", "cpAngleMode", "cpPoints", "cpSegments", "cpParabolas", "cpFunctions", "cppXMin", "cppXMax", "cppYMin", "cppYMax", "cppTolerance", "cppPoints", "cppVceTemplate", "cppPresetType", "cppPresetExpression", "cppPresetXValues", "bcTitle", "bcYMax", "bcOrientation", "bcCategoryAxisLabel", "bcValueAxisLabel", "bcItems", "histTitle", "histValues", "histBinCount", "boxTitle", "boxDatasetCount", "boxDatasets", "scTitle", "scPoints", "ptTitle", "ptPaths", "ptConditional", "dcTitle", "dcMean", "dcStdDev", "dcFrom", "dcTo", "fxTitle", "fxOperation", "fxNumeratorA", "fxDenominatorA", "fxNumeratorB", "fxDenominatorB", "ngTitle", "ngNodes", "ngEdges", "ngSource", "ngTarget", "ngFlowSource", "ngFlowSink", "mxTitle", "mxOperation", "mxMatrixA", "mxMatrixB", "slValues", "slStemUnit", "geoCanvasWidth", "geoCanvasHeight", "geoUnit", "geoFormulaNotation", "geoShapesInput", "pySideA", "pySideB", "pySideC", "pyCaption", "trigAngleDeg", "trigFunction", "trigOpposite", "trigAdjacent", "trigHypotenuse"]
  .forEach((id) => {
    document.getElementById(id).addEventListener("input", updateQuestionFromForm);
    document.getElementById(id).addEventListener("change", updateQuestionFromForm);
  });

document.getElementById("cppPresetType").addEventListener("change", () => {
  const presetType = String(document.getElementById("cppPresetType").value || "linear").trim() || "linear";
  const expressionInput = document.getElementById("cppPresetExpression");
  const xValuesInput = document.getElementById("cppPresetXValues");
  if (!String(expressionInput.value || "").trim()) {
    expressionInput.value = defaultCartesianPlotPresetExpression(presetType);
  }
  if (!String(xValuesInput.value || "").trim()) {
    xValuesInput.value = defaultCartesianPlotPresetXValues(presetType);
  }
  updateQuestionFromForm();
});

populateAutoCreateSubcategoryOptions();
updateAutoCreateCommandWordControl();

document.getElementById("cppGeneratePointsBtn").addEventListener("click", () => {
  const presetType = String(document.getElementById("cppPresetType").value || "linear").trim() || "linear";
  const expression = String(document.getElementById("cppPresetExpression").value || "").trim();
  const xValuesText = String(document.getElementById("cppPresetXValues").value || "").trim();
  const generated = generateCartesianPlotPresetPoints(
    presetType,
    expression || defaultCartesianPlotPresetExpression(presetType),
    xValuesText || defaultCartesianPlotPresetXValues(presetType)
  );

  if (generated.message) {
    showToast(generated.message, "warning");
    return;
  }

  document.getElementById("cppPoints").value = serializeCartesianPoints(generated.points);
  updateQuestionFromForm();
  showToast(`Generated ${generated.points.length} key points.`, "success");
});

document.getElementById("cppApplyTemplateBtn").addEventListener("click", () => {
  const templateId = String(document.getElementById("cppVceTemplate").value || "").trim();
  if (!templateId) {
    showToast("Choose a VCE template first.", "info");
    return;
  }

  const template = getCartesianPlotVceTemplate(templateId);
  if (!template) {
    showToast("Template not found.", "warning");
    return;
  }

  document.getElementById("cppPresetType").value = template.presetType;
  document.getElementById("cppPresetExpression").value = template.expression;
  document.getElementById("cppPresetXValues").value = template.xValues;
  document.getElementById("cppXMin").value = String(template.xMin);
  document.getElementById("cppXMax").value = String(template.xMax);
  document.getElementById("cppYMin").value = String(template.yMin);
  document.getElementById("cppYMax").value = String(template.yMax);
  document.getElementById("cppTolerance").value = String(template.tolerance);

  const generated = generateCartesianPlotPresetPoints(template.presetType, template.expression, template.xValues);
  if (!generated.message) {
    document.getElementById("cppPoints").value = serializeCartesianPoints(generated.points);
  }

  updateQuestionFromForm();
  showToast(`Applied template and generated ${generated.points.length || 0} key points.`, "success");
});

document.getElementById("boxDatasetCount").addEventListener("change", () => {
  const countInput = document.getElementById("boxDatasetCount");
  const datasetsInput = document.getElementById("boxDatasets");
  const nextCount = clampBoxPlotDatasetCount(countInput.value);
  countInput.value = String(nextCount);
  datasetsInput.value = serializeBoxPlotDatasets(parseBoxPlotDatasetsFromText(datasetsInput.value, nextCount));
  updateQuestionFromForm();
});

document.getElementById("toggleSolutionPanelBtn").addEventListener("click", () => {
  const body = document.getElementById("solutionPanelBody");
  if (!(body instanceof HTMLElement)) return;
  setSolutionPanelCollapsed(!body.classList.contains("hidden"));
});

document.getElementById("correctAnswerSelect").addEventListener("change", updateQuestionFromForm);

// Checkbox answer selection is handled via click listeners on each button in refreshCorrectAnswerSelect.

document.getElementById("embedFormatSelect").addEventListener("change", () => {
  updateEmbedOutputForActiveQuiz();
});

document.getElementById("quizFileName").addEventListener("change", () => {
  const quiz = activeQuiz();
  if (!quiz) return;

  const input = document.getElementById("quizFileName");
  const nextFileName = buildUniqueQuizFileName(input.value || quiz.title, quiz.id);
  const changed = nextFileName !== quiz.fileName;

  quiz.fileName = nextFileName;
  input.value = nextFileName;
  updateGeneratedJson();
  saveDraft();

  if (changed) {
    showToast(`Filename set to ${nextFileName}`, "success");
  }
});

document.getElementById("saveQuizBtn").addEventListener("click", async () => {
  await saveSelectedQuiz();
});

document.getElementById("connectRootBtn").addEventListener("click", async () => {
  await connectRootDirectoryHandle();
});

document.getElementById("downloadQuizBtn").addEventListener("click", () => {
  downloadSelectedQuizJson();
});

document.getElementById("copyJsonBtn").addEventListener("click", async () => {
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
  const json = JSON.stringify(getQuizData(), null, 2);
  try {
    await navigator.clipboard.writeText(json);
    showToast("JSON copied.", "success");
  } catch (error) {
    showToast("Could not copy JSON. Use the Generated JSON box.", "error");
  }
});

document.getElementById("clearQuizBtn").addEventListener("click", () => {
  if (!confirm("Clear all categories, quizzes, and questions?")) return;
  state.categories = [];
  state.selectedCategoryId = null;
  state.selectedQuizId = null;
  state.selectedQuestionIndex = -1;
  renderAll();
});

document.getElementById("closeQuizSettingsBtn").addEventListener("click", () => {
  closeQuizSettingsModal();
});

document.getElementById("cancelQuizSettingsBtn").addEventListener("click", () => {
  closeQuizSettingsModal();
});

document.getElementById("saveQuizSettingsBtn").addEventListener("click", () => {
  saveQuizSettingsFromModal();
});

document.querySelector("[data-close-quiz-settings='true']").addEventListener("click", () => {
  closeQuizSettingsModal();
});

document.getElementById("refreshRootBtn").addEventListener("click", async () => {
  await refreshLibraryFromRoot(true);
});

document.getElementById("quizRootFolder").addEventListener("change", () => {
  const rootInput = document.getElementById("quizRootFolder");
  state.rootFolder = normalizeRootFolder(rootInput.value);
  rootInput.value = state.rootFolder;
  saveDraft();
});

document.getElementById("rootSourceMode").addEventListener("change", () => {
  const rootSourceModeInput = document.getElementById("rootSourceMode");
  state.rootSourceMode = normalizeRootSourceMode(rootSourceModeInput.value);
  rootSourceModeInput.value = state.rootSourceMode;
  updateLocalFolderRowVisibility();
  saveDraft();
});

document.getElementById("interactiveAppType").addEventListener("change", () => {
  const type = document.getElementById("interactiveAppType").value;
  const resultTypeSelect = document.getElementById("resultType");
  if (!type) {
    setInteractiveAppConfigVisibility("");
    renderInteractiveAppPreview(null);
    if (activeQuestion()) updateQuestionFromForm();
    return;
  }

  const nextApp = buildDefaultInteractiveApp(type);
  if (type === "cartesian-plane-plot" && resultTypeSelect) {
    resultTypeSelect.value = "short-answer";
  }
  populateInteractiveAppForm(nextApp);
  if (activeQuestion()) {
    updateQuestionFromForm();
  }
});

document.getElementById("previewInteractiveAppBtn").addEventListener("click", () => {
  const app = readInteractiveAppFromForm();
  renderInteractiveAppPreview(app);
});

document.getElementById("toggleInteractiveAppPanelBtn").addEventListener("click", () => {
  const body = document.getElementById("interactiveAppPanelBody");
  const btn = document.getElementById("toggleInteractiveAppPanelBtn");
  const collapsed = !body.classList.contains("hidden");
  body.classList.toggle("hidden", collapsed);
  btn.textContent = collapsed ? "Expand" : "Collapse";
  btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
});

function normalizeQuestion(item) {
  const options = Array.isArray(item.options) ? item.options.slice(0, 4) : ["", "", "", ""];
  while (options.length < 4) {
    options.push("");
  }

  const resultType = normalizeResultType(item.resultType || "multiple-choice");

  const correctAnswerValue = Number.isInteger(item.correctAnswer)
    ? (options[item.correctAnswer] || "")
    : (item.correctAnswer || "");

  if (resultType === "true-false") {
    options[0] = "True";
    options[1] = "False";
    options[2] = "";
    options[3] = "";
  }

  const normalized = {
    question: item.question || "",
    resultType,
    options,
    correctAnswer: correctAnswerValue,
    notesAttachments: buildNotesAttachments(splitNotesAttachments(Array.isArray(item.notesAttachments) ? item.notesAttachments : [])),
    image: item.image || "",
    solution: item.solution || "",
    solutionAttachments: normalizeSolutionAttachments(item.solutionAttachments)
  };
  if (item.interactiveApp) normalized.interactiveApp = item.interactiveApp;
  return normalized;
}

function loadImportedData(data) {
  if (Array.isArray(data.questions) && !Array.isArray(data.categories)) {
    const category = createCategory(data.category || "General");
    const quiz = createQuiz(data.title || "Imported Quiz");
    applyLoadedQuizJsonToQuiz(quiz, data);
    quiz.fileName = buildUniqueQuizFileName(data.fileName || data.title || "Imported Quiz", quiz.id);
    quiz.sourcePath = data.sourcePath || data.fileName || "";
    quiz.questions = data.questions.map(normalizeQuestion);
    category.quizzes.push(quiz);
    state.categories = [category];
    state.selectedCategoryId = category.id;
    state.selectedQuizId = quiz.id;
    state.selectedQuestionIndex = quiz.questions.length > 0 ? 0 : -1;
    ensureQuizFileNames();
    renderAll();
    return;
  }

  if (Array.isArray(data.categories)) {
    state.categories = data.categories.map((category) => ({
      id: category.id || `cat-${categorySeed++}`,
      name: category.name || "Category",
      quizzes: Array.isArray(category.quizzes)
        ? category.quizzes.map((quiz) => ({
          id: quiz.id || `quiz-${quizSeed++}`,
          title: quiz.title || "Untitled Quiz",
          description: normalizeQuizDescription(quiz.description),
          settings: normalizeQuizSettings(quiz.settings),
          fileName: quiz.fileName || "",
          sourcePath: quiz.sourcePath || "",
          questions: Array.isArray(quiz.questions) ? quiz.questions.map(normalizeQuestion) : []
        }))
        : []
    }));
    ensureQuizFileNames();
    renderAll();
    return;
  }

  if (Array.isArray(data.questions)) {
    const category = createCategory("General");
    const quiz = createQuiz(data.title || "Imported Quiz");
    applyLoadedQuizJsonToQuiz(quiz, data);
    quiz.fileName = buildUniqueQuizFileName(data.fileName || data.title || "Imported Quiz", quiz.id);
    quiz.sourcePath = data.sourcePath || data.fileName || "";
    quiz.questions = data.questions.map(normalizeQuestion);
    category.quizzes.push(quiz);
    state.categories = [category];
    state.selectedCategoryId = category.id;
    state.selectedQuizId = quiz.id;
    state.selectedQuestionIndex = quiz.questions.length > 0 ? 0 : -1;
    ensureQuizFileNames();
    renderAll();
    return;
  }

  throw new Error("Invalid quiz file");
}

async function initialize() {
  await restoreRootDirectoryHandle({ promptForPermission: false });
  updateLocalFolderRowVisibility();

  const loadedFromRoot = await refreshLibraryFromRoot(false, false);
  if (loadedFromRoot) {
    showToast("Detected quizzes from root folder.", "success");
    return;
  }

  const hasDraft = loadDraft();
  if (hasDraft) {
    renderAll();
    setRootStatus(`Source: draft data (root ${state.rootFolder})`);
    showToast("Draft restored.", "info");
    return;
  }

  const starterCategory = createCategory("General");
  const starterQuiz = createQuiz("Sample Quiz");
  starterQuiz.questions.push(createEmptyQuestion());
  starterCategory.quizzes.push(starterQuiz);

  state.categories = [starterCategory];
  state.selectedCategoryId = starterCategory.id;
  state.selectedQuizId = starterQuiz.id;
  state.selectedQuestionIndex = 0;
  renderAll();
  setRootStatus("Source: starter quiz (no root index found)");
}

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    document.getElementById("saveQuizBtn").click();
    return;
  }

  if (isTypingInField(event.target)) {
    return;
  }

  if (!event.repeat && event.key.toLowerCase() === "n") {
    event.preventDefault();
    void addQuestion();
    return;
  }

  if (!event.repeat && event.key === "Delete") {
    event.preventDefault();
    if (state.selectedQuestionIndex < 0) {
      showToast("No selected question to delete.", "warning");
      return;
    }

    void deleteQuestion(state.selectedQuestionIndex);
    showToast("Question deleted.", "info");
  }
});

window.addEventListener("load", () => {
  console.log(`Quiz Maker v${APP_VERSION} loaded`);
  const versionBadge = document.getElementById("versionBadge");
  if (versionBadge) {
    versionBadge.textContent = `v${APP_VERSION}`;
  }
  initializeInteractiveAppTypePicker();
  initialize();
});





