// netlify/functions/submit-tree-update.js
//
// Receives a proposed change to the family tree from the public form and
// opens it as a GitHub pull request. Nothing is ever written directly to
// the main branch — every submission becomes a PR for a human to review
// and merge (or close).

const GITHUB_API = "https://api.github.com";

// ---- Configuration -----------------------------------------------------
// Set these as environment variables in Netlify (Site configuration >
// Environment variables), not hardcoded here. The fallbacks below are
// just placeholders so the file is self-explanatory.
const OWNER = process.env.GITHUB_OWNER || "your-github-username";
const REPO = process.env.GITHUB_REPO || "your-repo-name";
const BASE_BRANCH = process.env.GITHUB_BASE_BRANCH || "main";
// Path to the JSON file *inside the repo* — update this to match where
// family-tree-current.json actually lives (e.g. "data/family-tree.json").
const FILE_PATH = process.env.TREE_FILE_PATH || "data/family-tree.json";
// A GitHub fine-grained personal access token, scoped to ONLY this repo,
// with "Contents: Read and write" and "Pull requests: Read and write"
// permissions. Never commit this — set it as a Netlify env var.
const TOKEN = process.env.GITHUB_TOKEN;
// -------------------------------------------------------------------------

function ghHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function generateId(firstName, lastName, existingIds) {
  const base = slugify(`${firstName}-${lastName}`) || "person";
  let id = base;
  let i = 2;
  while (existingIds.has(id)) {
    id = `${base}-${i}`;
    i += 1;
  }
  return id;
}

function findPerson(tree, id) {
  return tree.find((p) => p.id === id);
}

function addToArray(obj, key, value) {
  if (!obj[key]) obj[key] = [];
  if (!obj[key].includes(value)) obj[key].push(value);
}

function applyChange(tree, payload) {
  const existingIds = new Set(tree.map((p) => p.id));
  const { actionType } = payload;

  if (actionType === "edit_person") {
    const person = findPerson(tree, payload.targetId);
    if (!person) {
      throw new Error(
        "Could not find that family member — they may have already been edited."
      );
    }
    const fieldMap = {
      "first name": "firstName",
      "last name": "lastName",
      birthday: "birthday",
      gender: "gender",
    };
    for (const [dataKey, payloadKey] of Object.entries(fieldMap)) {
      const val = (payload[payloadKey] || "").trim();
      if (val) person.data[dataKey] = val;
    }
    return {
      summary: `Updated info for ${person.data["first name"]} ${person.data["last name"]}`,
    };
  }

  if (actionType === "add_spouse") {
    const target = findPerson(tree, payload.targetId);
    if (!target) throw new Error("Could not find the family member you selected.");
    const newId = generateId(payload.firstName, payload.lastName, existingIds);
    const newPerson = {
      id: newId,
      data: {
        "first name": payload.firstName || "?",
        "last name": payload.lastName || "?",
        birthday: payload.birthday || "?",
        gender: payload.gender || "?",
      },
      rels: { spouses: [target.id] },
    };
    tree.push(newPerson);
    addToArray(target.rels, "spouses", newId);
    return {
      summary: `Added ${newPerson.data["first name"]} ${newPerson.data["last name"]} as spouse/partner of ${target.data["first name"]} ${target.data["last name"]}`,
    };
  }

  if (actionType === "add_child") {
    const parent1 = findPerson(tree, payload.parent1Id);
    if (!parent1) throw new Error("Could not find the parent you selected.");
    const parent2 = payload.parent2Id ? findPerson(tree, payload.parent2Id) : null;
    if (payload.parent2Id && !parent2) {
      throw new Error("Could not find the second parent you selected.");
    }

    const newId = generateId(payload.firstName, payload.lastName, existingIds);
    const parentIds = parent2 ? [parent1.id, parent2.id] : [parent1.id];
    const newPerson = {
      id: newId,
      data: {
        "first name": payload.firstName || "?",
        "last name": payload.lastName || "?",
        birthday: payload.birthday || "?",
        gender: payload.gender || "?",
      },
      rels: { parents: parentIds },
    };
    tree.push(newPerson);
    addToArray(parent1.rels, "children", newId);
    if (parent2) addToArray(parent2.rels, "children", newId);
    return {
      summary: `Added ${newPerson.data["first name"]} ${newPerson.data["last name"]} as a child of ${parent1.data["first name"]} ${parent1.data["last name"]}${
        parent2 ? ` and ${parent2.data["first name"]} ${parent2.data["last name"]}` : ""
      }`,
    };
  }

  throw new Error("Unknown action type.");
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: "Method not allowed." }) };
  }
  if (!TOKEN) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: "Server is missing GITHUB_TOKEN configuration." }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Invalid request." }) };
  }

  try {
    // 1. Read the current file + its sha (needed to commit an update)
    const fileRes = await fetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(FILE_PATH)}?ref=${BASE_BRANCH}`,
      { headers: ghHeaders() }
    );
    if (!fileRes.ok) {
      throw new Error(`Could not read the family tree file from GitHub (status ${fileRes.status}).`);
    }
    const fileData = await fileRes.json();
    const currentContent = Buffer.from(fileData.content, "base64").toString("utf8");
    const tree = JSON.parse(currentContent);

    // 2. Apply the requested change in memory
    const { summary } = applyChange(tree, payload);
    const newContent = JSON.stringify(tree, null, 2);

    // 3. Create a new branch off the base branch
    const refRes = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/ref/heads/${BASE_BRANCH}`, {
      headers: ghHeaders(),
    });
    if (!refRes.ok) throw new Error("Could not read the base branch.");
    const refData = await refRes.json();
    const branchName = `family-update-${Date.now()}`;
    const createRefRes = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/git/refs`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: refData.object.sha }),
    });
    if (!createRefRes.ok) throw new Error("Could not create a branch for this change.");

    // 4. Commit the updated file to the new branch
    const submitterNote = payload.submitterName
      ? `\n\nSubmitted by: ${payload.submitterName}${payload.submitterEmail ? ` (${payload.submitterEmail})` : ""}`
      : "";
    const commitRes = await fetch(
      `${GITHUB_API}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(FILE_PATH)}`,
      {
        method: "PUT",
        headers: ghHeaders(),
        body: JSON.stringify({
          message: `Family tree update: ${summary}`,
          content: Buffer.from(newContent, "utf8").toString("base64"),
          sha: fileData.sha,
          branch: branchName,
        }),
      }
    );
    if (!commitRes.ok) throw new Error("Could not save the change to GitHub.");

    // 5. Open the pull request
    const prRes = await fetch(`${GITHUB_API}/repos/${OWNER}/${REPO}/pulls`, {
      method: "POST",
      headers: ghHeaders(),
      body: JSON.stringify({
        title: `Family tree: ${summary}`,
        head: branchName,
        base: BASE_BRANCH,
        body: `This pull request was opened automatically from the family tree submission form.\n\n**Change:** ${summary}${submitterNote}\n\nReview the diff, and merge if everything looks correct.`,
      }),
    });
    if (!prRes.ok) throw new Error("Could not open a pull request.");

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, message: "Thanks! Your suggestion was submitted for review." }),
    };
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: err.message }) };
  }
};
