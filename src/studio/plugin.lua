-- Roblox Icon Renderer for Roblox Studio.
-- Installed and updated by the Roblox Icon Renderer app (toolbar or Settings > Roblox Studio); edits here are overwritten.
-- "Send to Renderer": each selected instance is sent as its own file, so several selected models become separate renders.
-- "Agent Link": lets AI agents connected to the app (MCP) browse Studio, read the selection and import models.
-- rir-plugin-version: 2

local HttpService = game:GetService("HttpService")
local Selection = game:GetService("Selection")
local SerializationService = game:GetService("SerializationService")
local EncodingService = game:GetService("EncodingService")
local RunService = game:GetService("RunService")

local BASE = "http://127.0.0.1:47823"
local HEADERS = { ["X-RIR"] = "1" }
local ICON = "rbxasset://textures/RobloxIconRenderer/icon.png"

local toolbar = plugin:CreateToolbar("Roblox Icon Renderer")
local sendButton = toolbar:CreateButton(
	"RIRSendSelection",
	"Send the selection to Roblox Icon Renderer (one render per selected item; sending the same item again updates it)",
	ICON,
	"Send to Renderer"
)
sendButton.ClickableWhenViewportHidden = true
local linkButton = toolbar:CreateButton(
	"RIRAgentLink",
	"Let AI agents connected to Roblox Icon Renderer browse this place and import models (on while highlighted)",
	ICON,
	"Agent Link"
)
linkButton.ClickableWhenViewportHidden = true

-- Instances handed to the app by id (the same ids the Send button uses), so agents can ask for them back.
local known = setmetatable({}, { __mode = "v" })
local function idOf(inst)
	local id = inst:GetDebugId(0)
	known[id] = inst
	return id
end

local function serialize(inst)
	return buffer.tostring(EncodingService:Base64Encode(SerializationService:SerializeInstancesAsync({ inst })))
end

local function post(path, body)
	return HttpService:PostAsync(BASE .. path, HttpService:JSONEncode(body), Enum.HttpContentType.ApplicationJson, false, HEADERS)
end

local function send()
	local items = {}
	for _, inst in Selection:Get() do
		local ok, result = pcall(serialize, inst)
		if ok then
			table.insert(items, { name = inst.Name, key = idOf(inst), data = result })
		else
			warn(`[Icon Renderer] Could not send {inst:GetFullName()}: {result}`)
		end
	end
	if #items == 0 then
		warn("[Icon Renderer] Select one or more models, parts or effects first.")
		return
	end
	local ok, err = pcall(post, "/studio", { items = items })
	if ok then
		print(`[Icon Renderer] Sent {#items} item{if #items == 1 then "" else "s"} to Roblox Icon Renderer`)
	else
		warn(`[Icon Renderer] Could not reach Roblox Icon Renderer. Is the app open? ({err})`)
	end
end

sendButton.Click:Connect(function()
	sendButton:SetActive(false)
	task.spawn(send)
end)

-- ---------- Agent Link ----------
local function describe(inst, depth, budget)
	local node = { id = idOf(inst), name = inst.Name, class = inst.ClassName, fullName = inst:GetFullName(), children = #inst:GetChildren() }
	budget.left -= 1
	if depth > 0 and node.children > 0 then
		node.items = {}
		for _, child in inst:GetChildren() do
			if budget.left <= 0 then
				node.truncated = true
				break
			end
			table.insert(node.items, describe(child, depth - 1, budget))
		end
	end
	return node
end

local TOP = { "Workspace", "ReplicatedStorage", "ServerStorage", "StarterPack", "StarterGui", "StarterPlayer", "Lighting", "ReplicatedFirst", "MaterialService" }

local handlers = {}
function handlers.browse(cmd)
	local budget = { left = 1500 }
	if cmd.target then
		local inst = known[cmd.target]
		if not inst or not inst.Parent then
			error(`Unknown or deleted instance id {cmd.target}; browse again`)
		end
		return { place = game.Name, nodes = { describe(inst, cmd.depth or 2, budget) }, truncated = budget.left <= 0 }
	end
	local nodes = {}
	for _, name in TOP do
		local ok, service = pcall(game.GetService, game, name)
		if ok and service then
			table.insert(nodes, describe(service, (cmd.depth or 2) - 1, budget))
		end
	end
	return { place = game.Name, nodes = nodes, truncated = budget.left <= 0 }
end
function handlers.selection()
	local out = {}
	for _, inst in Selection:Get() do
		table.insert(out, { id = idOf(inst), name = inst.Name, class = inst.ClassName, fullName = inst:GetFullName() })
	end
	return { place = game.Name, selection = out }
end
function handlers.import(cmd)
	local list, items, errors = {}, {}, {}
	for _, id in cmd.ids or {} do
		local inst = known[id]
		if inst and inst.Parent then
			table.insert(list, inst)
		else
			table.insert(errors, `Unknown or deleted instance id {id}`)
		end
	end
	if cmd.selection then
		for _, inst in Selection:Get() do
			table.insert(list, inst)
		end
	end
	for _, inst in list do
		local ok, result = pcall(serialize, inst)
		if ok then
			table.insert(items, { name = inst.Name, key = idOf(inst), data = result })
		else
			table.insert(errors, `{inst:GetFullName()}: {result}`)
		end
	end
	return { items = items, errors = errors }
end

local linkOn = plugin:GetSetting("RIRAgentLink") ~= false
local running = true
linkButton:SetActive(linkOn)
linkButton.Click:Connect(function()
	linkOn = not linkOn
	plugin:SetSetting("RIRAgentLink", linkOn)
	linkButton:SetActive(linkOn)
	print(`[Icon Renderer] Agent Link {if linkOn then "on" else "off"}`)
end)
plugin.Unloading:Connect(function()
	running = false
end)

-- Long poll: the app holds each request until an agent asks for something (or 15 s pass).
local function poll()
	while running do
		if not linkOn then
			task.wait(2)
			continue
		end
		local ok, res = pcall(HttpService.RequestAsync, HttpService, { Url = BASE .. "/studio/poll", Method = "GET", Headers = HEADERS })
		if not ok or not res.Success then
			task.wait(5) -- app closed: check again later
			continue
		end
		local cmd = HttpService:JSONDecode(res.Body)
		if cmd.id and handlers[cmd.type] then
			task.spawn(function()
				local done, data = pcall(handlers[cmd.type], cmd)
				pcall(post, "/studio/result", { id = cmd.id, ok = done, data = if done then data else nil, error = if done then nil else tostring(data) })
			end)
		end
	end
end

if RunService:IsEdit() then
	task.spawn(poll)
end
