--[[
TredMail delivery engine: KumoMTA policy.

  Worker --SMTP 2525--> KumoMTA --SMTP 25--> recipients' mail servers
                          |  delivery log records  --> POST api:3000/internal/mta/events
                          |  mail received on :25  --> POST api:3000/internal/mta/inbound
  Internet --SMTP 25--> KumoMTA  (only for TredMail's own domains: bounces, complaints,
                                  postmaster@/abuse@/dmarc@ on the platform domain)

Messages arrive already DKIM-signed by the worker, with a VERP envelope sender, so this
policy only routes, shapes and reports. Settings come from the container environment.
]]
local kumo = require 'kumo'

local function setting(name, default)
  local value = os.getenv(name)
  if value == nil or value == '' then
    return default
  end
  return value
end

local function split(list)
  local items = {}
  for item in string.gmatch(list, '[^,%s]+') do
    table.insert(items, item)
  end
  return items
end

local API_URL = setting('TREDMAIL_API_URL', 'http://api:3000')
local API_TOKEN = setting('INTERNAL_API_TOKEN', '')
local MTA_HOSTNAME = setting('MTA_HOSTNAME', 'mta1.tredmail.dovepeakdigital.com')
local PRIMARY_DOMAIN = setting('PRIMARY_DOMAIN', 'tredmail.dovepeakdigital.com'):lower()
local BOUNCE_DOMAIN = setting('BOUNCE_DOMAIN', 'bounces.' .. PRIMARY_DOMAIN):lower()
-- Networks allowed to inject mail on port 2525 (the Docker networks; never the internet)
local RELAY_NETWORKS = split(setting('MTA_RELAY_NETWORKS', '127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16'))
-- Development and staging: deliver everything to one host (e.g. mailpit:1025) instead of MX
local SMART_HOST = setting('MTA_SMART_HOST', '')
-- Bind outbound connections to a specific local IP (only when the server has several)
local SOURCE_ADDRESS = setting('MTA_SOURCE_ADDRESS', '')

-- Certificate for STARTTLS on port 25 (copied from Caddy by cert-sync). Until it exists,
-- KumoMTA uses a self-signed one, which senders accept for opportunistic TLS but which
-- MTA-STS would reject.
local TLS_CERT = setting('MTA_TLS_CERT', '/certs/mta.crt')
local TLS_KEY = setting('MTA_TLS_KEY', '/certs/mta.key')

local function file_exists(path)
  local f = io.open(path, 'r')
  if f then
    f:close()
    return true
  end
  return false
end

local HOOK_QUEUE = 'tredmail_events'
local INBOUND_QUEUE = 'tredmail_inbound'

if API_TOKEN == '' then
  error 'INTERNAL_API_TOKEN must be set: KumoMTA reports deliveries and bounces to the TredMail API with it'
end

-- Domains whose mail TredMail receives: its own platform domain, its bounce domain,
-- customers' bounces.<domain> CNAMEs that point at the bounce domain, and the mail server's
-- own name (Microsoft SNDS confirms access by mailing postmaster@<PTR name>).
local function is_inbound_domain(domain)
  domain = domain:lower()
  return domain == PRIMARY_DOMAIN
    or domain == BOUNCE_DOMAIN
    or domain == MTA_HOSTNAME:lower()
    or domain:sub(1, 8) == 'bounces.'
end

kumo.on('init', function()
  kumo.define_spool { name = 'data', path = '/var/spool/kumomta/data', kind = 'RocksDB' }
  kumo.define_spool { name = 'meta', path = '/var/spool/kumomta/meta', kind = 'RocksDB' }

  kumo.configure_local_logs { log_dir = '/var/log/kumomta', max_segment_duration = '1 hour' }
  kumo.configure_bounce_classifier {
    files = { '/opt/kumomta/share/bounce_classifier/iana.toml' },
  }
  kumo.configure_log_hook { name = 'tredmail' }

  -- Public port: receives reports and platform-domain mail, and never relays. (The broadcast
  -- address can never connect; an empty Lua table would be read as a map, not a list.)
  local public_listener = {
    listen = '0.0.0.0:25',
    hostname = MTA_HOSTNAME,
    relay_hosts = { '255.255.255.255/32' },
    max_message_size = 10 * 1024 * 1024,
  }
  if file_exists(TLS_CERT) and file_exists(TLS_KEY) then
    public_listener.tls_certificate = TLS_CERT
    public_listener.tls_private_key = TLS_KEY
  end
  kumo.start_esmtp_listener(public_listener)

  -- Injection port for the TredMail worker. Not published outside the Docker network.
  kumo.start_esmtp_listener {
    listen = '0.0.0.0:2525',
    hostname = MTA_HOSTNAME,
    relay_hosts = RELAY_NETWORKS,
    max_message_size = 40 * 1024 * 1024,
  }

  -- Metrics and admin API, internal only
  kumo.start_http_listener {
    listen = '0.0.0.0:8000',
    trusted_hosts = RELAY_NETWORKS,
  }
end)

-- Accept mail from the internet only for TredMail's own domains.
kumo.on('get_listener_domain', function(domain, listener, conn_meta)
  if is_inbound_domain(domain) then
    return kumo.make_listener_domain { relay_to = true }
  end
end)

-- Mail for TredMail's own domains is handed to the API instead of being relayed.
kumo.on('smtp_server_message_received', function(msg)
  if is_inbound_domain(msg:recipient().domain) then
    msg:set_meta('queue', INBOUND_QUEUE)
  end
end)

-- One IP for now. A second IP becomes a second source in this pool.
kumo.on('get_egress_pool', function(pool_name)
  return kumo.make_egress_pool {
    name = pool_name,
    entries = { { name = 'ip-1' } },
  }
end)

kumo.on('get_egress_source', function(source_name)
  local params = { name = source_name, ehlo_domain = MTA_HOSTNAME }
  if SOURCE_ADDRESS ~= '' then
    params.source_address = SOURCE_ADDRESS
  end
  return kumo.make_egress_source(params)
end)

kumo.on('get_queue_config', function(domain, tenant, campaign, routing_domain)
  if domain == HOOK_QUEUE then
    return kumo.make_queue_config {
      protocol = { custom_lua = { constructor = 'make.tredmail_events' } },
    }
  end
  if domain == INBOUND_QUEUE then
    return kumo.make_queue_config {
      max_age = '2 days',
      protocol = { custom_lua = { constructor = 'make.tredmail_inbound' } },
    }
  end

  local config = {
    egress_pool = 'transactional',
    -- Temporary failures are retried for 72 hours, then reported as expired (FAILED)
    max_age = '72 hours',
    retry_interval = '10 minutes',
    max_retry_interval = '2 hours',
  }
  if SMART_HOST ~= '' then
    local host = SMART_HOST:match '^([^:]+)'
    config.protocol = { smtp = { mx_list = { host } } }
  end
  return kumo.make_queue_config(config)
end)

--[[
Traffic shaping per receiving provider. KumoMTA groups MX hosts into "sites", so one rule
covers all of a provider's servers. Limits are deliberately gentle for a new IP; raise them
once Google Postmaster Tools and Microsoft SNDS show good reputation.
]]
local PROVIDER_LIMITS = {
  { match = 'google%.com', connection_limit = 3, max_deliveries_per_connection = 50, max_message_rate = '600/h' },
  { match = 'outlook%.com', connection_limit = 2, max_deliveries_per_connection = 20, max_message_rate = '300/h' },
  { match = 'yahoodns%.net', connection_limit = 2, max_deliveries_per_connection = 20, max_message_rate = '300/h' },
  { match = 'icloud%.com', connection_limit = 2, max_deliveries_per_connection = 20, max_message_rate = '300/h' },
}

kumo.on('get_egress_path_config', function(routing_domain, egress_source, site_name)
  local params = {
    connection_limit = 5,
    max_deliveries_per_connection = 50,
    enable_tls = 'OpportunisticInsecure',
  }
  if SMART_HOST ~= '' then
    params.smtp_port = tonumber(SMART_HOST:match ':(%d+)$') or 25
    params.enable_tls = 'Disabled'
    return kumo.make_egress_path(params)
  end
  for _, rule in ipairs(PROVIDER_LIMITS) do
    if string.find(site_name, rule.match) then
      params.connection_limit = rule.connection_limit
      params.max_deliveries_per_connection = rule.max_deliveries_per_connection
      params.max_message_rate = rule.max_message_rate
      break
    end
  end
  return kumo.make_egress_path(params)
end)

-- Report delivery outcomes (not receptions, and not this policy's own internal queues).
local REPORTED = { Delivery = true, Bounce = true, TransientFailure = true, Expiration = true, AdminBounce = true }

kumo.on('should_enqueue_log_record', function(msg, hook_name)
  local record = msg:get_meta 'log_record'
  if record.reception_protocol == 'LogRecord' then
    return false
  end
  if record.queue == HOOK_QUEUE or record.queue == INBOUND_QUEUE then
    return false
  end
  if hook_name == 'tredmail' and REPORTED[record.type] then
    msg:set_meta('queue', HOOK_QUEUE)
    return true
  end
  return false
end)

-- Retry while the API is unreachable or rejects the token; drop requests it says are invalid.
local function post(client, path, content_type, body, headers)
  local request = client
    :post(API_URL .. path)
    :header('Content-Type', content_type)
    :header('Authorization', 'Bearer ' .. API_TOKEN)
  for name, value in pairs(headers or {}) do
    request = request:header(name, value)
  end
  local response = request:body(body):send()
  local status = response:status_code()
  local disposition = string.format('%d %s', status, response:status_reason())
  if response:status_is_success() or status == 400 or status == 413 or status == 422 then
    return disposition
  end
  kumo.reject(500, disposition)
end

kumo.on('make.tredmail_events', function(domain, tenant, campaign)
  local client = kumo.http.build_client {}
  local sender = {}
  function sender:send(message)
    return post(client, '/internal/mta/events', 'application/json', message:get_data())
  end
  return sender
end)

kumo.on('make.tredmail_inbound', function(domain, tenant, campaign)
  local client = kumo.http.build_client {}
  local sender = {}
  function sender:send(message)
    return post(client, '/internal/mta/inbound', 'message/rfc822', message:get_data(), {
      ['X-Envelope-From'] = tostring(message:sender()),
      ['X-Envelope-To'] = tostring(message:recipient()),
    })
  end
  return sender
end)
