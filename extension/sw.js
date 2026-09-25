// Called by the gateway through CDP (Runtime.evaluate in this service worker).
// chrome.debugger.getTargets() maps a CDP targetId to a tab id without
// attaching, so no "being debugged" infobar is shown.

async function tabIdForTarget(targetId) {
  const targets = await chrome.debugger.getTargets();
  const target = targets.find(t => t.id === targetId);
  if (!target || target.tabId === undefined)
    throw new Error(`No tab for target ${targetId}`);
  return target.tabId;
}

async function loadGroups() {
  const { groups = {} } = await chrome.storage.session.get('groups');
  return groups;
}

async function existingGroup(groupId) {
  if (groupId === undefined)
    return undefined;
  return await chrome.tabGroups.get(groupId).then(() => groupId, () => undefined);
}

// Group changes run one at a time: two tabs of a new session arriving together
// must not each create a group.
let queue = Promise.resolve();
function serialized(fn) {
  return (...args) => {
    const run = queue.then(() => fn(...args));
    queue = run.catch(() => {});
    return run;
  };
}

// Adds the tab to the session's group, creating the group on first use.
self.apmAddToGroup = serialized(async (targetId, sessionKey, title, color) => {
  const tabId = await tabIdForTarget(targetId);
  const groups = await loadGroups();
  let groupId = await existingGroup(groups[sessionKey]);
  groupId = await chrome.tabs.group(groupId === undefined ? { tabIds: [tabId] } : { tabIds: [tabId], groupId });
  await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
  groups[sessionKey] = groupId;
  await chrome.storage.session.set({ groups });
  return groupId;
});

self.apmRenameGroup = serialized(async (sessionKey, title, color) => {
  const groups = await loadGroups();
  const groupId = await existingGroup(groups[sessionKey]);
  if (groupId !== undefined)
    await chrome.tabGroups.update(groupId, color ? { title, color } : { title });
  return groupId ?? null;
});

self.apmForgetGroup = serialized(async sessionKey => {
  const groups = await loadGroups();
  delete groups[sessionKey];
  await chrome.storage.session.set({ groups });
});

// Duplicates a tab like the browser's "Duplicate" command (history and
// sessionStorage come along) and returns the new tab's target id.
self.apmDuplicateTarget = async targetId => {
  const tab = await chrome.tabs.duplicate(await tabIdForTarget(targetId));
  for (let i = 0; i < 50; i++) {
    const target = (await chrome.debugger.getTargets()).find(t => t.tabId === tab.id);
    if (target)
      return target.id;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`No target for the duplicate of ${targetId}`);
};

// The gateway's status page stays pinned so the window never runs out of tabs.
self.apmPinTarget = async targetId => {
  const tabId = await tabIdForTarget(targetId);
  await chrome.tabs.update(tabId, { pinned: true });
};

self.apmPing = () => 'ok';
