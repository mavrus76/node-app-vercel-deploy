require("dotenv").config();

const path = require("path");
const express = require("express");
const nunjucks = require("nunjucks");
const { nanoid } = require("nanoid");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
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
};

setInterval(updateTimerProgress, 1000);

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
  const sessionId = req.cookies.sessionId;

  if (!req.cookies["sessionId"]) {
    return next();
  }

  const sessionsCollection = req.db.collection("sessions");
  const usersCollection = req.db.collection("users");

  const session = await sessionsCollection.findOne({ sessionId });
  if (session) {
    req.user = await usersCollection.findOne({
      _id: new ObjectId(session.userId),
    });
  }

  req.sessionId = sessionId;
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

    const sessionId = nanoid();
    const sessionsCollection = req.db.collection("sessions");
    await sessionsCollection.insertOne({
      userId: user._id.toString(),
      sessionId,
    });
    res.cookie("sessionId", sessionId, { httpOnly: true }).redirect("/");
  }
);

// Выход пользователя (удаление сессии)
app.get("/logout", requireAuth, async (req, res) => {
  const sessionId = req.cookies.sessionId;
  const sessionsCollection = req.db.collection("sessions");

  const session = await sessionsCollection.findOne({ sessionId });
  if (!session) {
    return res.redirect("/");
  }

  await sessionsCollection.deleteOne({ sessionId });
  res.clearCookie("sessionId").redirect("/");
});

// Получить список активных таймеров
app.get("/api/timers", requireAuth, async (req, res) => {
  const { isActive } = req.query;
  const sessionId = req.cookies.sessionId;
  const sessionsCollection = req.db.collection("sessions");
  const usersCollection = req.db.collection("users");
  const timersCollection = req.db.collection("timers");

  const session = await sessionsCollection.findOne({ sessionId });
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
  const sessionId = req.cookies.sessionId;
  const sessionsCollection = req.db.collection("sessions");
  const usersCollection = req.db.collection("users");
  const timersCollection = req.db.collection("timers");

  const session = await sessionsCollection.findOne({ sessionId });
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

app.listen(port, () => {
  console.log(` Listening on http://localhost:${port}`);
});
