const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const fs = require("fs").promises;
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
  pingTimeout: 30000,
  pingInterval: 25000,
  maxHttpBufferSize: 5e5,
  transports: ["websocket", "polling"],
});

const PORT = process.env.PORT || 3000;
const DEVICES_FILE = path.join(__dirname, "devices.json");

app.use(express.json({ limit: "500kb" }));
app.use(express.urlencoded({ extended: true, limit: "500kb" }));

let devices = [];
const deviceByKey = new Map();
const deviceByDeviceId = new Map();
const pendingRequests = new Map();
const generateId = () => crypto.randomBytes(8).toString("hex");
const generateDeviceId = () => `dev_${crypto.randomBytes(12).toString("hex")}`;

let cacheDirty = false;
const CACHE_SAVE_INTERVAL = 5000;

const loadDevices = async () => {
  try {
    const data = await fs.readFile(DEVICES_FILE, "utf8");
    devices = JSON.parse(data);

    devices.forEach(device => {
      deviceByKey.set(device.key, device);
      if (device.deviceid) {
        deviceByDeviceId.set(device.deviceid, device);
      }
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      await fs.writeFile(DEVICES_FILE, "[]");
    } else {
      console.error("Error loading devices:", error);
    }
  }
};

const saveDevices = async () => {
  if (!cacheDirty) return;
  
  try {
    await fs.writeFile(DEVICES_FILE, JSON.stringify(devices));
    cacheDirty = false;
  } catch (error) {
    console.error("Error saving devices:", error);
  }
};

setInterval(saveDevices, CACHE_SAVE_INTERVAL);

const isKeyValid = (device) => {
  return !device.expDate || Date.now() < new Date(device.expDate).getTime();
};

app.post("/device", async (req, res) => {
  const { key, expDate } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Key is required" });
  }

  if (deviceByKey.has(key)) {
    return res.status(409).json({ error: "Key already exists" });
  }

  const id = generateId();
  const deviceid = generateDeviceId();
  const newDevice = {
    id,
    key,
    deviceid,
    expDate: expDate || null,
    socketid: null,
  };

  devices.push(newDevice);
  deviceByKey.set(key, newDevice);
  deviceByDeviceId.set(deviceid, newDevice);
  cacheDirty = true;

  res.status(201).json({
    message: "Device key created successfully",
    id,
    deviceid,
  });
});

app.delete("/device/:key", async (req, res) => {
  const { key } = req.params;
  const device = deviceByKey.get(key);

  if (!device) {
    return res.status(404).json({ error: "Device key not found" });
  }

  if (device.socketid) {
    io.to(device.socketid).emit("force_disconnect", {
      reason: "Device key was deleted",
    });
    io.sockets.sockets.get(device.socketid)?.disconnect();
  }

  const index = devices.findIndex(d => d.key === key);
  if (index !== -1) devices.splice(index, 1);
  deviceByKey.delete(key);
  if (device.deviceid) deviceByDeviceId.delete(device.deviceid);
  cacheDirty = true;

  res.json({ message: "Device key deleted successfully" });
});

app.post("/register", async (req, res) => {
  const { key } = req.body;

  if (!key) {
    return res.status(400).json({ error: "Key is required" });
  }

  const device = deviceByKey.get(key);
  if (!device) {
    return res.status(404).json({ error: "Invalid key" });
  }

  if (!isKeyValid(device)) {
    return res.status(400).json({ error: "Key has expired" });
  }

  res.json({ 
    message: "Device registered successfully",
    deviceid: device.deviceid
  });
});

app.post("/send", async (req, res) => {
  const { deviceId, destNumber, textMessage } = req.body;

  if (!deviceId || !destNumber || !textMessage) {
    return res.status(400).json({
      error: "Device ID, destination number, and text message are required",
    });
  }

  const device = deviceByDeviceId.get(deviceId);
  if (!device) {
    return res.status(404).json({ error: "Device not registered" });
  }

  if (!device.socketid) {
    return res.status(404).json({ error: "Device not connected" });
  }

  const requestId = `${deviceId}-${Date.now()}-${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  try {
    const deviceResponse = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("Device did not respond in time"));
      }, 4500);

      pendingRequests.set(requestId, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });

      io.to(device.socketid).emit("insert-sms", {
        destNumber,
        textMessage,
        requestId,
      });
    });

    res.json({
      message: "Message processed by device",
      status: deviceResponse.status,
      deviceMessage: deviceResponse.message,
    });
  } catch (error) {
    pendingRequests.delete(requestId);
    res.status(408).json({
      error: error.message || "Device did not respond in time",
      status: false,
    });
  }
});

io.use((socket, next) => {
  const { deviceId } = socket.handshake.auth;

  if (!deviceId) {
    return next(new Error("Device ID is required"));
  }

  const device = deviceByDeviceId.get(deviceId);
  if (!device) {
    return next(new Error("Device not registered"));
  }

  socket.deviceId = deviceId;
  socket.deviceObj = device;
  next();
});

io.on("connection", (socket) => {
  console.log(`Device ${socket.deviceId} connected`);

  socket.deviceObj.socketid = socket.id;
  socket.join(socket.deviceId);
  cacheDirty = true;

  socket.emit("connected", {
    message: "Successfully connected to server",
    deviceId: socket.deviceId,
  });

  socket.on("sms-response", (response) => {
    const resolver = pendingRequests.get(response.requestId);
    if (resolver) {
      resolver(response);
    }
  });

  let lastHeartbeat = Date.now();
  const heartbeatCheck = setInterval(() => {
    if (Date.now() - lastHeartbeat > 30000) {
      socket.disconnect(true);
    }
  }, 10000);

  socket.on("heartbeat", (data) => {
    lastHeartbeat = Date.now();
  });

  socket.on("disconnect", (reason) => {
    console.log(`Device ${socket.deviceId} disconnected: ${reason}`);
    clearInterval(heartbeatCheck);

    if (socket.deviceObj) {
      socket.deviceObj.socketid = null;
      cacheDirty = true;
    }
  });
});

const startServer = async () => {
  try {
    await loadDevices();
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

process.on("SIGINT", async () => {
  console.log("Shutting down server...");

  devices.forEach(device => {
    device.socketid = null;
  });

  await saveDevices();
  server.close(() => {
    console.log("Server stopped");
    process.exit(0);
  });
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

startServer();