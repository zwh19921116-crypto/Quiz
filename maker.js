let categorySeed = 1;
let quizSeed = 1;
const DRAFT_STORAGE_KEY = "quiz-maker-draft-v1";
const DEFAULT_QUIZ_ROOT = "quizzes";
const ROOT_SOURCE_MODES = {
  AUTO: "auto",
  LOCAL: "local",
  GITHUB: "github"
};
let rootDirectoryHandle = null;

function splitPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((item) => item !== "");
}

const state = {
  categories: [],
  rootFolder: DEFAULT_QUIZ_ROOT,
  rootSourceMode: ROOT_SOURCE_MODES.AUTO,
  selectedCategoryId: null,
  selectedQuizId: null,
  selectedQuestionIndex: -1,
  draggingQuestionIndex: -1
};

function normalizeRootSourceMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === ROOT_SOURCE_MODES.LOCAL) return ROOT_SOURCE_MODES.LOCAL;
  if (mode === ROOT_SOURCE_MODES.GITHUB) return ROOT_SOURCE_MODES.GITHUB;
  return ROOT_SOURCE_MODES.AUTO;
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
    solution: ""
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

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeResultType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");

  if (["short-answer", "shortanswer", "short"].includes(normalized)) return "short-answer";
  if (["true-false", "truefalse", "boolean"].includes(normalized)) return "true-false";
  if (["checkbox", "multi-select", "multiselect"].includes(normalized)) return "checkbox";
  return "multiple-choice";
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

async function getRootDirectoryHandle() {
  if (rootDirectoryHandle) {
    return rootDirectoryHandle;
  }

  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  rootDirectoryHandle = handle;
  return handle;
}

async function getConfiguredRootHandle(options = {}) {
  const { create = false } = options;
  const rootHandle = await getRootDirectoryHandle();
  const rootSegments = splitPath(normalizeRootFolder(state.rootFolder));
  if (rootSegments.length === 0) {
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
      category: category.name || "Category",
      questions: Array.isArray(quiz.questions) && quiz.questions.length > 0
        ? quiz.questions.map((item) => ({
          question: item.question || "",
          resultType: item.resultType || "multiple-choice",
          options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
          correctAnswer: item.correctAnswer || "",
          notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
          image: item.image || "",
          solution: item.solution || ""
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

async function loadLibraryFromRoot() {
  const rootFolder = normalizeRootFolder(state.rootFolder);
  let context = resolveRootFetchContext(rootFolder);
  const rootSourceMode = normalizeRootSourceMode(state.rootSourceMode);

  console.log("[loadLibraryFromRoot] rootFolder:", rootFolder, "rootSourceMode:", rootSourceMode);
  console.log("[loadLibraryFromRoot] Initial context:", { githubRepo: context.githubRepo ? "present" : "null", supportsDirectoryScan: context.supportsDirectoryScan });

  if (rootSourceMode === ROOT_SOURCE_MODES.AUTO && !context.githubRepo && !isHttpUrl(rootFolder)) {
    console.log("[loadLibraryFromRoot] AUTO mode: attempting GitHub context inference");
    const inferred = inferGithubContextFromPages(rootFolder);
    if (inferred) {
      console.log("[loadLibraryFromRoot] GitHub context inferred successfully");
      context = inferred;
    } else {
      console.log("[loadLibraryFromRoot] GitHub context inference failed (not on github.io)");
    }
  }

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

    try {
      loadedCategories = await loadLibraryFromCategoryFolders(rootFolder);
      sourceMode = "folder-scan";
    } catch (folderScanError) {
      try {
        const shouldTryHandleFallback = supportsFolderDeletion();
        if (!shouldTryHandleFallback) {
          throw folderScanError;
        }

        const configuredRoot = await getConfiguredRootHandle({ create: false });
        loadedCategories = await loadLibraryFromHandleCategoryFolders(configuredRoot, rootFolder);
        sourceMode = "handle-folder-scan";
      } catch (localFolderError) {
        throw new Error(`Could not read category folders from local root: ${state.rootFolder}`);
      }
    }
  } else if (context.githubRepo) {
    console.log("[loadLibraryFromRoot] AUTO mode with GitHub context detected");
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
  } else if (context.supportsDirectoryScan) {
    try {
      loadedCategories = await loadLibraryFromCategoryFolders(rootFolder);
      sourceMode = "folder-scan";
    } catch (folderScanError) {
      try {
        const shouldTryHandleFallback = supportsFolderDeletion() && (window.location.protocol === "file:" || rootDirectoryHandle !== null);
        if (!shouldTryHandleFallback) {
          throw folderScanError;
        }

        const configuredRoot = await getConfiguredRootHandle({ create: false });
        loadedCategories = await loadLibraryFromHandleCategoryFolders(configuredRoot, rootFolder);
        sourceMode = "handle-folder-scan";
      } catch (localFolderError) {
        throw new Error(`Could not read category folders from local root: ${state.rootFolder}`);
      }
    }
  } else {
    loadedCategories = await loadLibraryFromManifest(context);
    sourceMode = "manifest";
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

async function refreshLibraryFromRoot(notify = true) {
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
    const sourceMode = await loadLibraryFromRoot();
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
  const optionValues = Array.isArray(question.options) ? question.options.map((item) => String(item || "").trim()) : [];
  const choiceOptions = optionValues.filter((item) => item !== "");
  const answerValue = String(question.correctAnswer || "").trim();

  if (!String(question.question || "").trim()) {
    issues.push("Question text is required.");
  }

  if (["multiple-choice", "checkbox", "true-false"].includes(resultType) && choiceOptions.length < 2) {
    issues.push("At least two options are required for this result type.");
  }

  if (!answerValue) {
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

  state.categories.forEach((category) => {
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

  category.quizzes.forEach((quiz) => {
    const row = document.createElement("div");
    row.className = `list-item ${quiz.id === state.selectedQuizId ? "active" : ""}`;
    row.innerHTML = `
      <button class="list-main" data-id="${quiz.id}" type="button">${quiz.title}</button>
      <button class="icon-btn secondary" data-action="rename" data-id="${quiz.id}" type="button">Rename</button>
      <button class="icon-btn secondary" data-action="embed" data-id="${quiz.id}" type="button">Link</button>
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

  quiz.questions.forEach((item, index) => {
    const title = item.question || `Untitled Question ${index + 1}`;
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

function refreshCorrectAnswerSelect(question) {
  const select = document.getElementById("correctAnswerSelect");
  const textInput = document.getElementById("correctAnswer");
  const checkboxWrap = document.getElementById("correctAnswerCheckboxWrap");
  const hint = document.getElementById("correctAnswerHint");
  const resultType = question ? (question.resultType || "multiple-choice") : "multiple-choice";
  const choiceOptions = getChoiceOptions(question);

  const useSelect = ["multiple-choice", "true-false"].includes(resultType);
  const useCheckboxPicker = resultType === "checkbox";
  select.style.display = useSelect ? "block" : "none";
  textInput.style.display = (!useSelect && !useCheckboxPicker) ? "block" : "none";
  checkboxWrap.style.display = useCheckboxPicker ? "block" : "none";

  if (resultType === "short-answer") {
    hint.textContent = "Enter the expected answer text.";
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
      const label = document.createElement("label");
      label.className = "checkbox-answer-item";
      label.innerHTML = `
        <input type="checkbox" data-role="correct-answer-check" data-index="${index}" value="${optionText}" />
        <span>${optionText}</span>
      `;

      const input = label.querySelector("input");
      if (input) {
        input.checked = existingAnswers.includes(normalizeText(optionText));
      }

      list.appendChild(label);
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
  if (!attachments || attachments.length === 0) {
    button.textContent = "Notes: N/A";
    preview.textContent = "n/a";
    return;
  }

  button.textContent = `Notes: ${attachments.length} attachment(s)`;
  preview.textContent = attachments.join(" | ");
}

function renderEditor() {
  const hint = document.getElementById("editorHint");
  const question = activeQuestion();
  const attachImageBtn = document.getElementById("attachImageBtn");
  const imageAttachHint = document.getElementById("imageAttachHint");

  if (!question) {
    hint.textContent = "Select a question to edit details.";
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
    document.getElementById("questionImage").value = "";
    document.getElementById("solutionText").value = "";
    updateImagePreview("");
    attachImageBtn.disabled = true;
    imageAttachHint.textContent = "Select a question first to attach an image.";
    updateNotesPreview([]);
    toggleOptionsBlock({ resultType: "multiple-choice" });
    refreshCorrectAnswerSelect({ resultType: "multiple-choice", options: ["", "", "", ""], correctAnswer: "" });
    renderValidationBox(null);
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
  document.getElementById("attachmentsInput").value = (question.notesAttachments || []).join("\n");
  document.getElementById("questionImage").value = question.image || "";
  document.getElementById("solutionText").value = question.solution || "";
  updateImagePreview(question.image || "");
  attachImageBtn.disabled = false;
  imageAttachHint.textContent = "Attach image for the selected question, or paste a URL above.";
  updateNotesPreview(question.notesAttachments || []);
  toggleOptionsBlock(question);
  refreshCorrectAnswerSelect(question);
  renderValidationBox(question);
}

function getQuizData() {
  const selectedQuiz = activeQuiz();
  const category = activeCategory();
  const selectedQuestions = selectedQuiz
    ? selectedQuiz.questions.map((item) => ({
      question: item.question || "",
      resultType: item.resultType || "multiple-choice",
      options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
      correctAnswer: item.correctAnswer || "",
      notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
      image: item.image || "",
      solution: item.solution || ""
    }))
    : [];

  return {
    id: selectedQuiz ? selectedQuiz.id : "",
    title: selectedQuiz ? selectedQuiz.title : "Untitled Quiz",
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

function addQuiz() {
  const category = activeCategory();
  if (!category) {
    showToast("Create a category first.", "warning");
    return;
  }

  const title = prompt("Quiz title:", `Quiz ${category.quizzes.length + 1}`);
  if (!title || !title.trim()) return;

  const quiz = createQuiz(title.trim());
  quiz.questions.push(createEmptyQuestion());
  category.quizzes.push(quiz);
  state.selectedQuizId = quiz.id;
  state.selectedQuestionIndex = 0;
  renderAll();
}

function renameQuiz(id) {
  const category = activeCategory();
  if (!category) return;

  const quiz = category.quizzes.find((item) => item.id === id);
  if (!quiz) return;

  const currentStem = String(quiz.fileName || quiz.title || "quiz").replace(/\.json$/i, "");
  const nextStem = prompt("Rename quiz file (without .json):", currentStem);
  if (!nextStem || !nextStem.trim()) return;

  const nextFileName = buildUniqueQuizFileName(nextStem.trim(), quiz.id);
  if (nextFileName === quiz.fileName) return;

  quiz.fileName = nextFileName;
  quiz.title = nextFileName.replace(/\.json$/i, "");
  // Force save path resolution to use the renamed filename on next save.
  quiz.sourcePath = "";

  renderAll();

  if (normalizeRootSourceMode(state.rootSourceMode) === ROOT_SOURCE_MODES.GITHUB || isHttpUrl(state.rootFolder)) {
    showToast("Filename updated in Maker. For GitHub, rename file in repo and refresh.", "info");
    return;
  }

  showToast("Filename updated. Click Save Selected Quiz to write the new file.", "success");
}

function addQuestion() {
  const quiz = activeQuiz();
  if (!quiz) {
    showToast("Create a quiz first.", "warning");
    return;
  }

  quiz.questions.push(createEmptyQuestion());
  state.selectedQuestionIndex = quiz.questions.length - 1;
  renderAll();
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

function deleteQuiz(id) {
  if (!requireDeletePhrase("quiz")) return;

  const category = activeCategory();
  if (!category) return;
  const index = category.quizzes.findIndex((item) => item.id === id);
  if (index === -1) return;
  category.quizzes.splice(index, 1);
  showToast("Quiz deleted.", "info");
  renderAll();
}

function deleteQuestion(index) {
  const quiz = activeQuiz();
  if (!quiz || index < 0 || index >= quiz.questions.length) return;
  quiz.questions.splice(index, 1);
  renderAll();
}

function updateQuestionFromForm() {
  const question = activeQuestion();
  if (!question) return;

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
    ensureDefaultCorrectAnswer(question);
    refreshCorrectAnswerSelect(question);

    const select = document.getElementById("correctAnswerSelect");
    const index = Number.parseInt(select.value, 10);
    const choiceOptions = getChoiceOptions(question);
    question.correctAnswer = Number.isInteger(index) && index >= 0 && index < choiceOptions.length
      ? choiceOptions[index]
      : "";
  } else if (question.resultType === "checkbox") {
    const choiceOptions = getChoiceOptions(question);
    const currentChecked = Array.from(document.querySelectorAll("input[data-role='correct-answer-check']:checked"))
      .map((item) => item.value.trim())
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

  question.notesAttachments = document.getElementById("attachmentsInput").value
    .split("\n")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  question.image = document.getElementById("questionImage").value.trim();
  question.solution = document.getElementById("solutionText").value.trim();

  toggleOptionsBlock(question);
  updateNotesPreview(question.notesAttachments);
  updateImagePreview(question.image);
  renderQuestionsList();
  renderValidationBox(question);
  updateGeneratedJson();
  saveDraft();
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
    category: category.name || "General",
    questions: (selectedQuiz.questions || []).map((item) => ({
      question: item.question || "",
      resultType: item.resultType || "multiple-choice",
      options: Array.isArray(item.options) ? item.options : ["", "", "", ""],
      correctAnswer: item.correctAnswer || "",
      notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
      image: item.image || "",
      solution: item.solution || ""
    }))
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

async function writeSelectedQuizToDisk() {
  const quiz = activeQuiz();
  const category = activeCategory();
  const payload = buildPersistedQuizPayload();
  if (!quiz || !category || !payload) {
    showToast("Select a quiz first.", "warning");
    return false;
  }

  if (!supportsFolderDeletion()) {
    return false;
  }

  try {
    const configuredRoot = await getConfiguredRootHandle({ create: true });
    const relativePath = await resolveWritableQuizRelativePath(configuredRoot, quiz, category);
    const parts = relativePath.split("/").filter((item) => item !== "");
    if (parts.length === 0) {
      showToast("Could not resolve save path.", "error");
      return false;
    }

    const fileName = parts.pop();
    if (!fileName || !fileName.toLowerCase().endsWith(".json")) {
      showToast("Quiz file name must end with .json", "warning");
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
    showToast(`Saved ${[...parts, fileName].join("/")}`, "success");
    return true;
  } catch (error) {
    if (error && error.name === "AbortError") {
      showToast("Save canceled.", "info");
      return false;
    }

    showToast("Could not save to local folder.", "warning");
    return false;
  }
}

function downloadSelectedQuizJson() {
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

async function saveSelectedQuiz() {
  const saved = await writeSelectedQuizToDisk();
  if (!saved) {
    showToast("Save failed. Use Connect Root Folder and try again.", "warning");
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

document.getElementById("addCategoryBtn").addEventListener("click", addCategory);
document.getElementById("addQuizBtn").addEventListener("click", addQuiz);
document.getElementById("addQuestionBtn").addEventListener("click", addQuestion);
document.getElementById("attachImageBtn").addEventListener("click", () => {
  const question = activeQuestion();
  if (!question) {
    showToast("Select a question first.", "warning");
    return;
  }

  document.getElementById("imageFileInput").click();
});

document.getElementById("imageFileInput").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files && target.files[0];
  attachImageToQuestion(file || null);
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

document.getElementById("quizList").addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;

  const id = target.dataset.id;
  if (!id) return;

  if (target.dataset.action === "delete") {
    deleteQuiz(id);
    return;
  }

  if (target.dataset.action === "rename") {
    renameQuiz(id);
    return;
  }

  if (target.dataset.action === "embed") {
    generateAndCopyEmbedCode(id);
    return;
  }

  state.selectedQuizId = id;
  state.selectedQuestionIndex = -1;
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
    deleteQuestion(index);
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
  const saved = await saveSelectedQuiz();
  if (saved) {
    showToast("Question changes saved.", "success");
    return;
  }

  showToast("Question updated in Maker, but file save failed.", "warning");
});

["questionText", "resultType", "option1", "option2", "option3", "option4", "correctAnswer", "attachmentsInput", "questionImage", "solutionText"]
  .forEach((id) => {
    document.getElementById(id).addEventListener("input", updateQuestionFromForm);
    document.getElementById(id).addEventListener("change", updateQuestionFromForm);
  });

document.getElementById("correctAnswerSelect").addEventListener("change", updateQuestionFromForm);

document.getElementById("correctAnswerCheckboxWrap").addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  if (target.dataset.role !== "correct-answer-check") return;
  updateQuestionFromForm();
});

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
  saveDraft();
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

  return {
    question: item.question || "",
    resultType,
    options,
    correctAnswer: correctAnswerValue,
    notesAttachments: Array.isArray(item.notesAttachments) ? item.notesAttachments : [],
    image: item.image || "",
    solution: item.solution || ""
  };
}

function loadImportedData(data) {
  if (Array.isArray(data.questions) && !Array.isArray(data.categories)) {
    const category = createCategory(data.category || "General");
    const quiz = createQuiz(data.title || "Imported Quiz");
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

document.getElementById("importQuizFile").addEventListener("change", async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data && typeof data === "object" && !Array.isArray(data) && !data.fileName) {
      data.fileName = file.name;
    }
    if (data && typeof data === "object" && !Array.isArray(data) && !data.sourcePath) {
      data.sourcePath = file.name;
    }
    loadImportedData(data);
    setRootStatus(`Source: imported ${file.name}`);
    showToast("Quiz imported.", "success");
  } catch (error) {
    showToast("Invalid JSON file.", "error");
  }

  event.target.value = "";
});

async function initialize() {
  const loadedFromRoot = await refreshLibraryFromRoot(false);
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
    addQuestion();
    return;
  }

  if (!event.repeat && event.key === "Delete") {
    event.preventDefault();
    if (state.selectedQuestionIndex < 0) {
      showToast("No selected question to delete.", "warning");
      return;
    }

    deleteQuestion(state.selectedQuestionIndex);
    showToast("Question deleted.", "info");
  }
});

window.addEventListener("load", () => {
  initialize();
});