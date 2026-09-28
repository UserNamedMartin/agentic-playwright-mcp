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
// `siblings` are the session's other tabs: when the stored group is unknown
// (the extension was reloaded), their group is the session's.
self.apmAddToGroup = serialized(async (targetId, sessionKey, title, color, siblings = []) => {
  const tabId = await tabIdForTarget(targetId);
  const groups = await loadGroups();
  let groupId = await existingGroup(groups[sessionKey]);
  for (const sibling of groupId === undefined ? siblings : []) {
    const tab = await tabIdForTarget(sibling).then(id => chrome.tabs.get(id), () => undefined);
    if (tab && tab.groupId !== undefined && tab.groupId !== -1) {
      groupId = tab.groupId;
      break;
    }
  }
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

// Sound: while nobody can see the browser, every tab is muted (for the user;
// pages do not notice, media keeps playing for them). Tabs the user muted
// themselves stay as they are.
async function setTabMuted(tab, muted) {
  const info = tab.mutedInfo || {};
  if (muted && !info.muted)
    await chrome.tabs.update(tab.id, { muted: true });
  else if (!muted && info.muted && info.reason === 'extension' && info.extensionId === chrome.runtime.id)
    await chrome.tabs.update(tab.id, { muted: false });
}

self.apmSetMuted = serialized(async muted => {
  await chrome.storage.session.set({ muteAll: muted });
  for (const tab of await chrome.tabs.query({}))
    await setTabMuted(tab, muted).catch(() => {});
  return muted;
});

chrome.tabs.onCreated.addListener(async tab => {
  const { muteAll } = await chrome.storage.session.get('muteAll');
  if (muteAll)
    await setTabMuted(tab, true).catch(() => {});
});

// Puts a tab in front of its window. Unlike Target.activateTarget over CDP,
// this does not bring a minimized window back into view.
self.apmActivateTarget = async targetId => {
  await chrome.tabs.update(await tabIdForTarget(targetId), { active: true });
};

// While nobody can see the browser, the gateway keeps its status page in
// front of its window: Chrome does not draw the front tab of a minimized
// window, so an agent's tab there stops rendering. Tabs come to the front in
// many ways (a fork's "Duplicate", window.open, Chrome picking a neighbour
// when the front tab closes), so every change of the front tab is answered,
// not only the moment the window goes out of sight. null lets the front tab
// be. Kept in session storage: the service worker may be stopped in between.
async function keepInFront(targetId) {
  const tabId = await tabIdForTarget(targetId).catch(() => undefined);
  if (tabId === undefined)
    return;
  for (let i = 0; i < 5; i++) {
    // "Tabs cannot be edited right now" while Chrome is still moving tabs.
    if (await chrome.tabs.update(tabId, { active: true }).then(() => true, () => false))
      return;
    await new Promise(r => setTimeout(r, 100));
  }
}

self.apmKeepInFront = async targetId => {
  await chrome.storage.session.set({ keepFront: targetId ?? null });
  if (targetId)
    await keepInFront(targetId);
};

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  const { keepFront } = await chrome.storage.session.get('keepFront');
  if (!keepFront)
    return;
  const front = await tabIdForTarget(keepFront).then(id => chrome.tabs.get(id), () => undefined);
  if (front && front.id !== tabId && front.windowId === windowId)
    await keepInFront(keepFront);
});

// The target id of the tab in front of the window that holds this target,
// or null.
self.apmFrontTarget = async targetId => {
  const { windowId } = await chrome.tabs.get(await tabIdForTarget(targetId));
  const [front] = await chrome.tabs.query({ active: true, windowId });
  if (!front)
    return null;
  return (await chrome.debugger.getTargets()).find(t => t.tabId === front.id)?.id ?? null;
};

self.apmPing = () => 'ok';
// What this version of the extension can do: the gateway reloads an older
// one it finds still running.
self.apmVersion = 4;
