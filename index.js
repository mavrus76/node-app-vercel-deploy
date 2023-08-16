require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const cookieParser = require("cookie-parser");
const cookie = require("cookie");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const WebSocket = require("ws");

const app = express();
const { MongoClient, ObjectId } = require("mongodb");

const clientPromise = MongoClient.connect(process.env.DB_URI, {
  useUnifiedTopology: true,
  maxPoolSize: 10,
  wtimeoutMS: 2500,
  useNewUrlParser: true,
});

app.use(async (req, res, next) => {
  try {
    const client = await clientPromise;
    req.db = client.db("timers");
    next();
  } catch (err) {
    next(err);
  }
});

nunjucks.configure("views", {
  autoescape: true,
  express: app,
  tags: {
    blockStart: "[%",
    blockEnd: "%]",
    variableStart: "[[",
    variableEnd: "]]",
    commentStart: "[#",
    commentEnd: "#]",
  },
});

app.set("view engine", "njk");
app.use(express.json());
app.use(express.static(path.join(__dirname + "/public")));
app.use(cookieParser());

const server = http.createServer(app);

const wss = new WebSocket.Server({ clientTracking: false, noServer: true });
const clients = new Map();

server.on("upgrade", async (req, socket, head) => {
  const client = await clientPromise;
  const db = client.db("timers");
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.token;
  const sessionsCollection = db.collection("sessions");
  const session = await sessionsCollection.findOne({ token });
  const userId = session ? session.userId : null;

  if (!userId) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  req.userId = userId;
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const cookies = cookie.parse(req.headers.cookie || "");
  const token = cookies.token;

  if (!token) {
    ws.close(401, "Unauthorized");
    return;
  }

  const userId = req.userId;
  clients.set(userId, ws);

  sendAllTimers(userId);

  ws.on("message", async (message) => {
    try {
      const client = await clientPromise;
      const db = client.db("timers");
      const data = JSON.parse(message);
      const usersCollection = db.collection("users");
      const sessionsCollection = db.collection("sessions");

      const session = await sessionsCollection.findOne({ token });
      const user = await usersCollection.findOne({
        _id: new ObjectId(session.userId),
      });

      if (data.type === "all_timers" || data.type === "active_timers") {
        const fullMessage = JSON.stringify({
          type: data.type,
          message: data.message,
          name: user.username,
        });

        for (const ws of clients.values()) {
          ws.send(fullMessage);
        }
      }
    } catch (err) {
      console.error(err);
    }
  });

  ws.on("close", () => {
    clients.delete(userId);
  });
});

const updateTimerProgress = async () => {
  const client = await clientPromise;
  const db = client.db("timers");
  const timersCollection = db.collection("timers");

  const timers = await timersCollection.find({ isActive: true }).toArray();

  for (const timer of timers) {
    await timersCollection.updateOne(
      { _id: timer._id },
      { $set: { progress: timer.progress + 1000 } }
    );
  }

  for (const [userId, ws] of clients.entries()) {
    await sendAllTimers(userId);
    await sendActiveTimers(userId, ws);
  }
};

setInterval(updateTimerProgress, 1000);

const sendAllTimers = async (userId) => {
  const client = await clientPromise;
  const db = client.db("timers");
  const timersCollection = db.collection("timers");
  const usersCollection = db.collection("users");

  const user = await usersCollection.findOne({
    _id: new ObjectId(userId),
  });
  const timers = await timersCollection.find({ name: user.username }).toArray();

  const timersWithId = timers.map((timer) => {
    return { id: timer._id, ...timer };
  });

  const ws = clients.get(userId);
  if (ws) {
    ws.send(JSON.stringify({ type: "all_timers", timers: timersWithId }));
  }
};

const sendActiveTimers = async (userId, ws) => {
  const client = await clientPromise;
  const db = client.db("timers");
  const timersCollection = db.collection("timers");
  const usersCollection = db.collection("users");

  const user = await usersCollection.findOne({
    _id: new ObjectId(userId),
  });
  const timers = await timersCollection
    .find({ name: user.username, isActive: true })
    .toArray();

  const activeTimers = timers.map((timer) => {
    return { id: timer._id, ...timer };
  });

  if (ws) {
    ws.send(JSON.stringify({ type: "active_timers", timers: activeTimers }));
  }
};

// Функция для создания хеша пароля
const hashPassword = async (password) => {
  const saltRounds = 10;
  const salt = await bcrypt.genSalt(saltRounds);
  const hash = await bcrypt.hash(password, salt);

  return hash;
};

// Функция для проверки соответствия пароля хешу
const comparePassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

// Проверка авторизации пользователя
const requireAuth = async (req, res, next) => {
  const token = req.cookies.token;

  if (!token) {
    return next();
  }

  const sessionsCollection = req.db.collection("sessions");
  const usersCollection = req.db.collection("users");

  const session = await sessionsCollection.findOne({ token });
  if (session) {
    req.user = await usersCollection.findOne({
      _id: new ObjectId(session.userId),
    });
  }

  req.token = token;
  return next();
};

// Регистрация пользователя
app.post(
  "/signup",
  bodyParser.urlencoded({ extended: false }),
  async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      res.sendStatus(400);
      return;
    }

    const usersCollection = req.db.collection("users");
    const existingUser = await usersCollection.findOne({ username });
    if (existingUser) {
      res.sendStatus(409);
      return;
    }

    const hashedPassword = await hashPassword(password);
    const newUser = {
      username,
      password: hashedPassword,
    };

    await usersCollection.insertOne(newUser);
    res.sendStatus(201);
  }
);

// Аутентификация пользователя
app.post(
  "/login",
  bodyParser.urlencoded({ extended: false }),
  async (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.redirect("/?authError=true");
    }

    const usersCollection = req.db.collection("users");
    const user = await usersCollection.findOne({ username });

    if (!user) {
      res.sendStatus(401);
      return;
    }

    const passwordMatch = await comparePassword(password, user.password);
    if (!passwordMatch) {
      res.sendStatus(401);
      return;
    }

    const token = nanoid();
    const sessionsCollection = req.db.collection("sessions");
    await sessionsCollection.insertOne({
      userId: user._id.toString(),
      token,
    });
    res.cookie("token", token, { httpOnly: true }).redirect("/");
  }
);

// Выход пользователя (удаление сессии)
app.get("/logout", requireAuth, async (req, res) => {
  const token = req.cookies.token;
  const sessionsCollection = req.db.collection("sessions");

  const session = await sessionsCollection.findOne({ token });
  if (!session) {
    return res.redirect("/");
  }

  await sessionsCollection.deleteOne({ token });
  res.clearCookie("sessionId").redirect("/");
});

// Получить список активных таймеров
app.get("/api/timers", requireAuth, async (req, res) => {
  const { isActive } = req.query;
  const token = req.cookies.token;
  const sessionsCollection = req.db.collection("sessions");
  const usersCollection = req.db.collection("users");
  const timersCollection = req.db.collection("timers");

  const session = await sessionsCollection.findOne({ token });
  if (!session) return;
  const user = await usersCollection.findOne({
    _id: new ObjectId(session.userId),
  });

  const timers = await timersCollection
    .find({
      isActive: isActive == "true",
      name: user.username,
    })
    .toArray();

  const timersWithId = timers.map((timer) => {
    return { id: timer._id, ...timer };
  });

  res.json(timersWithId);
});

// Создать новый таймер
app.post("/api/timers", requireAuth, async (req, res) => {
  const { description } = req.body;
  const token = req.cookies.token;
  const sessionsCollection = req.db.collection("sessions");
  const usersCollection = req.db.collection("users");
  const timersCollection = req.db.collection("timers");

  const session = await sessionsCollection.findOne({ token });
  if (!session) return;
  const user = await usersCollection.findOne({
    _id: new ObjectId(session.userId),
  });

  const newTimer = {
    name: user.username,
    start: Date.now(),
    description,
    isActive: true,
    progress: 0,
  };

  const { insertedId } = await timersCollection.insertOne(newTimer);
  newTimer.id = insertedId;

  res.json(newTimer);
});

// Остановить таймер
app.post("/api/timers/:id/stop", requireAuth, async (req, res) => {
  const { id } = req.params;

  const timersCollection = req.db.collection("timers");
  const timer = await timersCollection.findOne({
    _id: new ObjectId(id),
  });

  if (timer) {
    await timersCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isActive: false,
          end: Date.now(),
          duration: Date.now() - Number(timer.start),
        },
      }
    );

    res.status(204).json({});
  } else {
    res.status(404).send(`Unknown timer ID: ${id}`);
  }
});

app.get("/", requireAuth, async (req, res) => {
  res.render("index", {
    user: req.user,
    authError:
      req.query.authError === "true"
        ? "Wrong username or password"
        : req.query.authError,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(500).send(err.message);
});

const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(` Listening on http://localhost:${port}`);
});
