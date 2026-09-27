import { useEffect, useMemo, useState } from "react";
import {
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  Button,
  Card,
  Dialog,
  IconButton,
  MD3LightTheme,
  Modal,
  Portal,
  Provider as PaperProvider,
  Snackbar,
  Switch,
  Text,
  TextInput,
} from "react-native-paper";
import { auth, db } from "./src/firebase";

type Category =
  "engine_oils" | "oil_filters" | "diesel_filters" | "spare_parts";
type Item = {
  id: string;
  name: string;
  brand: string;
  quantity: number;
  category: Category;
  barcode?: string;
  unitPrice?: number;
};
type InventoryEvent = {
  id: string;
  itemId: string;
  itemName: string;
  category: Category;
  action: "added" | "updated" | "deleted" | "sold";
  quantityChange: number;
  occurredAt?: Timestamp;
};
type LocalLockConfig = {
  pin: string;
  biometric: boolean;
};
const categories: { value: Category; label: string; icon: string }[] = [
  { value: "engine_oils", label: "Engine oils", icon: "oil" },
  { value: "oil_filters", label: "Oil filters", icon: "filter" },
  { value: "diesel_filters", label: "Diesel filters", icon: "fuel" },
  { value: "spare_parts", label: "Spare parts", icon: "tractor" },
];
const emptyForm = {
  name: "",
  brand: "",
  quantity: "0",
  barcode: "",
  unitPrice: "0",
};
const localLockStorageKey = (uid: string) =>
  `garage_local_lock_${Array.from(uid, (character) => character.codePointAt(0)!.toString(16)).join("_")}`;
const appTheme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    primary: "#173f35",
    onSurface: "#242222",
    onSurfaceVariant: "#59615e",
    surface: "#ffffff",
    background: "#f7f8f6",
  },
};

function SplashScreen() {
  return (
    <View style={styles.splash}>
      <View style={styles.splashIllustration}>
        <MaterialCommunityIcons name="tractor" size={132} color="#d6a84f" />
        <View style={styles.sun}>
          <MaterialCommunityIcons
            name="weather-sunny"
            size={54}
            color="#f4d58a"
          />
        </View>
      </View>
      <Text variant="displaySmall" style={styles.splashTitle}>
        Garage<Text style={styles.accent}>Inventory</Text>
      </Text>
      <Text style={styles.splashSubtitle}>
        Smart stock control for every workshop.
      </Text>
      <View style={styles.splashLoader}>
        <View style={styles.splashLoaderFill} />
      </View>
      <Text style={styles.splashLoading}>Preparing your garage...</Text>
    </View>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!email.trim() || !password)
      return setError("Enter both your email and password.");
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (caughtError) {
      const code = (caughtError as { code?: string }).code;
      if (code === "auth/operation-not-allowed")
        setError(
          "Email/password sign-in is disabled. Enable it in Firebase Authentication > Sign-in method.",
        );
      else if (
        code === "auth/invalid-credential" ||
        code === "auth/wrong-password" ||
        code === "auth/user-not-found"
      )
        setError("The email or password is incorrect.");
      else if (code === "auth/invalid-email")
        setError("Enter a valid email address.");
      else
        setError(
          `Sign-in failed${code ? ` (${code})` : ""}. Check your Firebase settings.`,
        );
    }
  };
  return (
    <View style={styles.login}>
      <Text variant="headlineLarge" style={styles.title}>
        Garage<Text style={styles.accent}>Inventory</Text>
      </Text>
      <Text style={styles.muted}>Stock control for the workshop floor.</Text>
      <Card style={styles.loginCard}>
        <Card.Content>
          <Text variant="titleLarge" style={styles.loginHeading}>
            Welcome back
          </Text>
          <TextInput
            label="Email address"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
            textColor="#242222"
            placeholderTextColor="#68716e"
            style={styles.input}
          />
          <TextInput
            label="Password"
            secureTextEntry={!showPassword}
            value={password}
            onChangeText={setPassword}
            textColor="#242222"
            placeholderTextColor="#68716e"
            right={
              <TextInput.Icon
                icon={showPassword ? "eye-off" : "eye"}
                onPress={() => setShowPassword((visible) => !visible)}
                accessibilityLabel={showPassword ? "Hide password" : "Show password"}
              />
            }
            style={styles.input}
          />
          <Button mode="contained" icon="login" onPress={submit}>
            Sign in
          </Button>
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </Card.Content>
      </Card>
    </View>
  );
}

export default function App() {
  const [user, setUser] = useState(auth.currentUser);
  const [unlockStatus, setUnlockStatus] = useState<"loading" | "setup" | "locked" | "unlocked">(
    Platform.OS === "web" || !auth.currentUser ? "unlocked" : "loading",
  );
  const [lockConfig, setLockConfig] = useState<LocalLockConfig | null>(null);
  const [biometricAvailable, setBiometricAvailable] = useState(false);
  const [useBiometric, setUseBiometric] = useState(false);
  const [unlockPin, setUnlockPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [unlockError, setUnlockError] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<InventoryEvent[]>([]);
  const [activePage, setActivePage] = useState<Category | "dashboard">("dashboard");
  const [search, setSearch] = useState("");
  const [inventoryPage, setInventoryPage] = useState(1);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<Item | null>(null);
  const [modal, setModal] = useState(false);
  const [scanner, setScanner] = useState(false);
  const [saleModal, setSaleModal] = useState(false);
  const [saleScanner, setSaleScanner] = useState(false);
  const [saleBarcode, setSaleBarcode] = useState("");
  const [saleItemId, setSaleItemId] = useState<string | null>(null);
  const [saleQuantity, setSaleQuantity] = useState("1");
  const [mobileDrawer, setMobileDrawer] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [notice, setNotice] = useState("");
  const [showSplash, setShowSplash] = useState(true);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const category = activePage === "dashboard" ? "engine_oils" : activePage;
  useEffect(
    () =>
      onAuthStateChanged(auth, (nextUser) => {
        setUser(nextUser);
        setUnlockError("");
        setUnlockPin("");
        setConfirmPin("");
        setLockConfig(null);
        setUnlockStatus(Platform.OS === "web" || !nextUser ? "unlocked" : "loading");
      }),
    [],
  );
  useEffect(() => {
    if (!user || Platform.OS === "web") {
      setUnlockStatus("unlocked");
      return;
    }
    let cancelled = false;
    setUnlockStatus("loading");
    Promise.all([
      SecureStore.getItemAsync(localLockStorageKey(user.uid)),
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]).then(([storedConfig, hasHardware, isEnrolled]) => {
      if (cancelled) return;
      setBiometricAvailable(hasHardware && isEnrolled);
      if (!storedConfig) {
        setLockConfig(null);
        setUseBiometric(hasHardware && isEnrolled);
        setUnlockStatus("setup");
        return;
      }
      try {
        const parsed = JSON.parse(storedConfig) as LocalLockConfig;
        if (!/^\d{6}$/.test(parsed.pin)) throw new Error("Invalid local lock configuration");
        setLockConfig(parsed);
        setUnlockStatus("locked");
      } catch {
        setLockConfig(null);
        setUnlockStatus("setup");
      }
    }).catch(() => {
      if (!cancelled) {
        setUnlockError("Secure device storage is unavailable. Restart the app and try again.");
        setUnlockStatus("setup");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [user]);
  useEffect(() => {
    if (Platform.OS === "web" || !user) return;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        setUnlockStatus((current) => current === "unlocked" ? "locked" : current);
      }
    });
    return () => subscription.remove();
  }, [user]);
  useEffect(() => {
    if (showSplash || unlockStatus !== "locked" || !lockConfig?.biometric) return;
    let cancelled = false;
    LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock Garage Inventory",
      cancelLabel: "Use PIN",
      disableDeviceFallback: true,
    }).then((result) => {
      if (!cancelled && result.success) {
        setUnlockError("");
        setUnlockStatus("unlocked");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [showSplash, unlockStatus, lockConfig]);
  useEffect(() => {
    const timer = setTimeout(() => setShowSplash(false), 30000);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!user || (Platform.OS !== "web" && unlockStatus !== "unlocked")) return;
    const unsubscribers = categories.map(({ value }) =>
      onSnapshot(collection(db, value), (snapshot) =>
        setItems((current) => {
          const incoming = snapshot.docs.map((item) => ({
            id: item.id,
            ...(item.data() as Omit<Item, "id">),
          }));
          return [
            ...current.filter((existing) => existing.category !== value),
            ...incoming,
          ];
        }),
      ),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [user, unlockStatus]);
  useEffect(() => {
    if (!user || (Platform.OS !== "web" && unlockStatus !== "unlocked")) return;
    const historyStart = new Date();
    historyStart.setHours(0, 0, 0, 0);
    historyStart.setDate(historyStart.getDate() - 6);
    const historyQuery = query(
      collection(db, "inventory_history"),
      where("occurredAt", ">=", Timestamp.fromDate(historyStart)),
    );
    return onSnapshot(historyQuery, (snapshot) => {
      setHistory(snapshot.docs.map((event) => ({ id: event.id, ...(event.data() as Omit<InventoryEvent, "id">) })));
    });
  }, [user, unlockStatus]);
  const visible = useMemo(
    () =>
      items.filter(
        (item) =>
          item.category === category &&
          `${item.name} ${item.brand} ${item.barcode ?? ""}`
            .toLowerCase()
            .includes(search.toLowerCase()),
      ),
    [items, category, search],
  );
  const pageSize = 8;
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  const currentInventoryPage = Math.min(inventoryPage, pageCount);
  const pageItems = visible.slice(
    (currentInventoryPage - 1) * pageSize,
    currentInventoryPage * pageSize,
  );
  useEffect(() => {
    if (inventoryPage > pageCount) setInventoryPage(pageCount);
  }, [inventoryPage, pageCount]);
  const totalUnits = items.reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0,
  );
  const categoryStats = categories.map((entry, index) => {
    const categoryItems = items.filter((item) => item.category === entry.value);
    return {
      ...entry,
      chartColor: ["#34745c", "#d6a84f", "#6695a5", "#cf795f"][index],
      products: categoryItems.length,
      units: categoryItems.reduce((sum, item) => sum + Number(item.quantity || 0), 0),
      lowStock: categoryItems.filter((item) => item.quantity <= 5).length,
    };
  });
  const maxCategoryUnits = Math.max(1, ...categoryStats.map((entry) => entry.units));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const weeklyHistory = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (6 - index));
    const dayEvents = history.filter((event) => {
      const occurredAt = event.occurredAt?.toDate();
      return occurredAt?.toDateString() === date.toDateString();
    });
    return {
      label: date.toLocaleDateString(undefined, { weekday: "short" }),
      incoming: dayEvents.reduce((sum, event) => sum + Math.max(0, event.quantityChange), 0),
      outgoing: dayEvents.reduce((sum, event) => sum + Math.max(0, -event.quantityChange), 0),
    };
  });
  const maxDailyMovement = Math.max(1, ...weeklyHistory.map((day) => day.incoming + day.outgoing));
  if (showSplash)
    return (
      <PaperProvider theme={appTheme}>
        <SplashScreen />
      </PaperProvider>
    );
  if (!user)
    return (
      <PaperProvider theme={appTheme}>
        <Login />
      </PaperProvider>
    );
  const saveLocalPin = async () => {
    if (!/^\d{6}$/.test(unlockPin)) {
      setUnlockError("Choose a six-digit PIN.");
      return;
    }
    if (unlockPin !== confirmPin) {
      setUnlockError("The PIN entries do not match.");
      return;
    }
    try {
      const config: LocalLockConfig = {
        pin: unlockPin,
        biometric: useBiometric && biometricAvailable,
      };
      await SecureStore.setItemAsync(localLockStorageKey(user.uid), JSON.stringify(config));
      setLockConfig(config);
      setUnlockPin("");
      setConfirmPin("");
      setUnlockError("");
      setUnlockStatus("unlocked");
    } catch (caughtError) {
      const detail = caughtError instanceof Error ? caughtError.message : "Unknown secure-storage error";
      setUnlockError(`Could not save your PIN securely: ${detail}`);
    }
  };
  const unlockWithPin = async () => {
    if (!lockConfig || !/^\d{6}$/.test(unlockPin)) {
      setUnlockError("Enter your six-digit PIN.");
      return;
    }
    if (unlockPin !== lockConfig.pin) {
      setUnlockPin("");
      setUnlockError("That PIN is not correct. Try again or use biometrics.");
      return;
    }
    setUnlockPin("");
    setUnlockError("");
    setUnlockStatus("unlocked");
  };
  const unlockWithBiometrics = async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: "Unlock Garage Inventory",
      cancelLabel: "Use PIN",
      disableDeviceFallback: true,
    });
    if (result.success) {
      setUnlockError("");
      setUnlockStatus("unlocked");
    }
  };
  if (Platform.OS !== "web" && unlockStatus !== "unlocked")
    return (
      <PaperProvider theme={appTheme}>
        <View style={styles.unlockScreen}>
          <View style={styles.unlockBrand}>
            <MaterialCommunityIcons name="tractor" size={38} color="#d6a84f" />
            <Text variant="titleLarge" style={styles.unlockTitle}>Garage<Text style={styles.accent}>Inventory</Text></Text>
          </View>
          <Card style={styles.unlockCard}>
            <Card.Content>
              {unlockStatus === "loading" ? (
                <>
                  <Text variant="titleLarge" style={styles.unlockHeading}>Checking device security</Text>
                  <Text style={styles.muted}>Please wait...</Text>
                </>
              ) : unlockStatus === "setup" ? (
                <>
                  <Text variant="titleLarge" style={styles.unlockHeading}>Set your app PIN</Text>
                  <Text style={styles.muted}>Use this PIN to unlock Garage Inventory on this device.</Text>
                  <TextInput
                    label="Create 6-digit PIN"
                    value={unlockPin}
                    onChangeText={(value) => setUnlockPin(value.replace(/\D/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={6}
                    style={styles.input}
                  />
                  <TextInput
                    label="Confirm PIN"
                    value={confirmPin}
                    onChangeText={(value) => setConfirmPin(value.replace(/\D/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={6}
                    style={styles.input}
                  />
                  {biometricAvailable ? (
                    <Pressable style={styles.biometricOption} onPress={() => setUseBiometric((enabled) => !enabled)}>
                      <View style={styles.biometricCopy}>
                        <MaterialCommunityIcons name="fingerprint" size={23} color="#173f35" />
                        <View style={styles.biometricText}>
                          <Text style={styles.biometricLabel}>Use fingerprint or Face ID</Text>
                          <Text style={styles.fieldHelp}>Your device biometrics stay on the device.</Text>
                        </View>
                      </View>
                      <Switch value={useBiometric} onValueChange={setUseBiometric} />
                    </Pressable>
                  ) : null}
                  <Button mode="contained" onPress={saveLocalPin} style={styles.unlockAction}>Save PIN and continue</Button>
                </>
              ) : (
                <>
                  <View style={styles.lockIcon}>
                    <MaterialCommunityIcons name="lock-outline" size={28} color="#173f35" />
                  </View>
                  <Text variant="titleLarge" style={styles.unlockHeading}>Unlock Garage Inventory</Text>
                  <TextInput
                    label="6-digit app PIN"
                    value={unlockPin}
                    onChangeText={(value) => setUnlockPin(value.replace(/\D/g, "").slice(0, 6))}
                    keyboardType="number-pad"
                    secureTextEntry
                    maxLength={6}
                    onSubmitEditing={unlockWithPin}
                    style={styles.input}
                  />
                  <Button mode="contained" onPress={unlockWithPin} style={styles.unlockAction}>Unlock</Button>
                  {lockConfig?.biometric ? (
                    <Button mode="outlined" icon="fingerprint" onPress={unlockWithBiometrics} style={styles.unlockBiometric}>
                      Use fingerprint or Face ID
                    </Button>
                  ) : null}
                </>
              )}
              {unlockError ? <Text style={styles.error}>{unlockError}</Text> : null}
              <Button mode="text" icon="logout" onPress={() => signOut(auth)} style={styles.unlockLogout}>Sign out</Button>
            </Card.Content>
          </Card>
        </View>
      </PaperProvider>
    );
  const save = async () => {
    const data = {
      ...form,
      quantity: Number(form.quantity) || 0,
      unitPrice: Number(form.unitPrice) || 0,
      category,
      updatedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    const itemRef = editing
      ? doc(db, editing.category, editing.id)
      : doc(collection(db, category));
    if (editing) batch.update(itemRef, data);
    else batch.set(itemRef, {
        ...data,
        createdAt: serverTimestamp(),
      });
    batch.set(doc(collection(db, "inventory_history")), {
      itemId: itemRef.id,
      itemName: form.name.trim(),
      category,
      action: editing ? "updated" : "added",
      quantityChange: editing ? Number(form.quantity || 0) - editing.quantity : Number(form.quantity || 0),
      occurredAt: serverTimestamp(),
    });
    await batch.commit();
    setModal(false);
    setEditing(null);
    setForm(emptyForm);
    setNotice(editing ? "Item updated" : "Item added");
  };
  const remove = async (item: Item) => {
    const batch = writeBatch(db);
    batch.delete(doc(db, item.category, item.id));
    batch.set(doc(collection(db, "inventory_history")), {
      itemId: item.id,
      itemName: item.name,
      category: item.category,
      action: "deleted",
      quantityChange: -item.quantity,
      occurredAt: serverTimestamp(),
    });
    await batch.commit();
    setNotice("Item deleted");
  };
  const saleItem = saleBarcode.trim()
    ? items.find((item) => item.barcode?.trim() === saleBarcode.trim())
    : items.find((item) => item.id === saleItemId);
  const openSale = (item?: Item) => {
    setSaleBarcode(item?.barcode ?? "");
    setSaleItemId(item?.id ?? null);
    setSaleQuantity("1");
    setSaleModal(true);
  };
  const submitSale = async () => {
    const quantity = Number(saleQuantity);
    if (!saleItem) return setNotice("No item matches that barcode.");
    if (!Number.isInteger(quantity) || quantity < 1) return setNotice("Enter a whole quantity greater than zero.");
    if (quantity > saleItem.quantity) return setNotice(`Only ${saleItem.quantity} available in stock.`);
    const itemRef = doc(db, saleItem.category, saleItem.id);
    const historyRef = doc(collection(db, "inventory_history"));
    try {
      await runTransaction(db, async (transaction) => {
        const snapshot = await transaction.get(itemRef);
        if (!snapshot.exists()) throw new Error("This inventory item no longer exists.");
        const available = Number(snapshot.data().quantity || 0);
        if (quantity > available) throw new Error(`Only ${available} available in stock.`);
        transaction.update(itemRef, {
          quantity: available - quantity,
          lastSoldAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        transaction.set(historyRef, {
          itemId: saleItem.id,
          itemName: saleItem.name,
          category: saleItem.category,
          action: "sold",
          quantityChange: -quantity,
          occurredAt: serverTimestamp(),
        });
      });
      setSaleModal(false);
      setSaleBarcode("");
      setSaleItemId(null);
      setSaleQuantity("1");
      setNotice(`Sold ${quantity} ${quantity === 1 ? "unit" : "units"} of ${saleItem.name}.`);
    } catch (caughtError) {
      setNotice(caughtError instanceof Error ? caughtError.message : "Could not complete this sale.");
    }
  };
  const scanSale = ({ data }: { data: string }) => {
    setSaleBarcode(data.trim());
    setSaleScanner(false);
  };
  const launchSaleScanner = () => {
    if (Platform.OS === "web") return setNotice("Barcode scanning is available on Android and iOS.");
    if (!permission?.granted) {
      requestPermission();
      return setNotice("Allow camera access, then tap scan again.");
    }
    setSaleScanner(true);
  };
  const scan = async ({ data }: { data: string }) => {
    setScanner(false);
    const found = items.find((item) => item.barcode === data);
    if (found) {
      setActivePage(found.category);
      setEditing(found);
      setForm({
        name: found.name,
        brand: found.brand,
        quantity: String(found.quantity),
        barcode: data,
        unitPrice: String(found.unitPrice ?? 0),
      });
      setModal(true);
    } else {
      setForm({ ...emptyForm, barcode: data });
      setModal(true);
      setNotice("Barcode captured. Complete the new item details.");
    }
  };
  const navigateTo = (page: Category | "dashboard") => {
    setActivePage(page);
    setSearch("");
    setInventoryPage(1);
    setMobileDrawer(false);
  };
  const openNewItem = () => {
    setEditing(null);
    setForm(emptyForm);
    setModal(true);
  };
  const renderNavigation = () => (
    <View style={styles.navigation}>
      <Text style={styles.navigationLabel}>WORKSPACE</Text>
      <Pressable
        style={[styles.navigationItem, activePage === "dashboard" && styles.navigationItemActive]}
        onPress={() => navigateTo("dashboard")}
      >
        <MaterialCommunityIcons
          name="view-dashboard-outline"
          size={20}
          color={activePage === "dashboard" ? "#173f35" : "#59615e"}
        />
        <Text style={[styles.navigationText, activePage === "dashboard" && styles.navigationTextActive]}>
          Dashboard
        </Text>
      </Pressable>
      <Text style={[styles.navigationLabel, styles.categoryLabel]}>INVENTORY</Text>
      {categories.map((entry) => {
        const selected = activePage === entry.value;
        return (
          <Pressable
            key={entry.value}
            style={[styles.navigationItem, selected && styles.navigationItemActive]}
            onPress={() => navigateTo(entry.value)}
          >
            <MaterialCommunityIcons
              name={entry.icon as "oil"}
              size={20}
              color={selected ? "#173f35" : "#59615e"}
            />
            <Text style={[styles.navigationText, selected && styles.navigationTextActive]}>
              {entry.value === "engine_oils" ? "Engine Oil" : entry.value === "oil_filters" ? "Oil Filter" : entry.value === "diesel_filters" ? "Diesel Filter" : "Spare Parts"}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
  return (
    <PaperProvider theme={appTheme}>
      <View style={styles.app}>
        <View style={styles.topbar}>
          {!desktop ? (
            <IconButton
              icon="menu"
              iconColor="#ffffff"
              onPress={() => setMobileDrawer(true)}
              accessibilityLabel="Open navigation menu"
            />
          ) : null}
          <View>
            <Text variant="headlineSmall" style={styles.topTitle}>
              Garage<Text style={styles.accent}>Inventory</Text>
            </Text>
            <Text style={styles.muted}>Workshop stock dashboard</Text>
          </View>
          <IconButton
            icon="logout"
            iconColor="#ffffff"
            onPress={() => signOut(auth)}
            accessibilityLabel="Log out"
          />
        </View>
        <View style={styles.workspace}>
          {desktop ? renderNavigation() : null}
          <ScrollView contentContainerStyle={styles.screenContent}>
            {activePage === "dashboard" ? (
              <>
                <View style={styles.pageHeading}>
                  <View>
                    <Text variant="headlineMedium" style={styles.pageTitle}>Dashboard</Text>
                    <Text style={styles.muted}>Live overview of stock across the garage.</Text>
                  </View>
                </View>
                <View style={styles.stats}>
                  <Card style={styles.stat}>
                    <Card.Content>
                      <Text style={styles.statLabel}>Total units</Text>
                      <Text variant="headlineMedium">{totalUnits}</Text>
                      <Text style={styles.muted}>Across all categories</Text>
                    </Card.Content>
                  </Card>
                  <Card style={styles.stat}>
                    <Card.Content>
                      <Text style={styles.statLabel}>Products</Text>
                      <Text variant="headlineMedium">{items.length}</Text>
                      <Text style={styles.muted}>Unique stock lines</Text>
                    </Card.Content>
                  </Card>
                  <Card style={[styles.stat, styles.warningStat]}>
                    <Card.Content>
                      <Text style={styles.statLabel}>Low stock</Text>
                      <Text variant="headlineMedium">{items.filter((item) => item.quantity <= 5).length}</Text>
                      <Text style={styles.muted}>At or below 5 units</Text>
                    </Card.Content>
                  </Card>
                </View>
                <View style={styles.chartGrid}>
                  <Card style={styles.chartCard}>
                    <Card.Content>
                      <View style={styles.sectionHeading}>
                        <View>
                          <Text variant="titleLarge">Stock by category</Text>
                          <Text style={styles.muted}>Current units and product lines</Text>
                        </View>
                        <MaterialCommunityIcons name="chart-bar" size={22} color="#173f35" />
                      </View>
                      <View style={styles.chartRows}>
                        {categoryStats.map((entry) => (
                          <View key={entry.value} style={styles.chartRow}>
                            <View style={styles.chartLabelRow}>
                              <View style={styles.chartName}>
                                <MaterialCommunityIcons name={entry.icon as "oil"} size={18} color={entry.chartColor} />
                                <Text style={styles.chartCategoryName}>{entry.label}</Text>
                              </View>
                              <Text style={styles.chartValue}>{entry.units} units</Text>
                            </View>
                            <View style={styles.barTrack}>
                              <View style={[styles.barFill, { width: `${(entry.units / maxCategoryUnits) * 100}%`, backgroundColor: entry.chartColor }]} />
                            </View>
                            <Text style={styles.chartCaption}>{entry.products} products · {entry.lowStock} low stock</Text>
                          </View>
                        ))}
                      </View>
                    </Card.Content>
                  </Card>
                  <Card style={styles.chartCard}>
                    <Card.Content>
                      <View style={styles.sectionHeading}>
                        <View>
                          <Text variant="titleLarge">Stock mix</Text>
                          <Text style={styles.muted}>Share of all available units</Text>
                        </View>
                        <MaterialCommunityIcons name="chart-donut" size={22} color="#173f35" />
                      </View>
                      <View style={styles.mixTrack}>
                        {categoryStats.map((entry) => (
                          <View
                            key={entry.value}
                            style={[styles.mixSegment, { width: `${totalUnits ? (entry.units / totalUnits) * 100 : 0}%`, backgroundColor: entry.chartColor }]}
                          />
                        ))}
                      </View>
                      <View style={styles.mixLegend}>
                        {categoryStats.map((entry) => (
                          <View key={entry.value} style={styles.mixLegendRow}>
                            <View style={[styles.mixSwatch, { backgroundColor: entry.chartColor }]} />
                            <Text style={styles.mixLegendLabel}>{entry.label}</Text>
                            <Text style={styles.mixLegendValue}>{totalUnits ? Math.round((entry.units / totalUnits) * 100) : 0}%</Text>
                          </View>
                        ))}
                      </View>
                    </Card.Content>
                  </Card>
                </View>
                <Card style={styles.historyCard}>
                  <Card.Content>
                    <View style={styles.sectionHeading}>
                      <View>
                        <Text variant="titleLarge">Stock movement</Text>
                        <Text style={styles.muted}>Daily quantity changes · last 7 days</Text>
                      </View>
                      <MaterialCommunityIcons name="chart-timeline-variant" size={22} color="#173f35" />
                    </View>
                    <View style={styles.historyLegend}>
                      <View style={styles.historyLegendItem}>
                        <View style={[styles.historyLegendSwatch, styles.incomingSwatch]} />
                        <Text style={styles.chartCaption}>Added</Text>
                      </View>
                      <View style={styles.historyLegendItem}>
                        <View style={[styles.historyLegendSwatch, styles.outgoingSwatch]} />
                        <Text style={styles.chartCaption}>Removed or sold</Text>
                      </View>
                    </View>
                    {weeklyHistory.some((day) => day.incoming + day.outgoing > 0) ? (
                      <View style={styles.historyRows}>
                        {weeklyHistory.map((day, index) => (
                          <View key={`${day.label}-${index}`} style={styles.historyDayRow}>
                            <Text style={styles.historyDayLabel}>{day.label}</Text>
                            <View style={styles.historyTrack}>
                              <View style={[styles.historyBar, styles.incomingBar, { width: `${(day.incoming / maxDailyMovement) * 100}%` }]} />
                              <View style={[styles.historyBar, styles.outgoingBar, { width: `${(day.outgoing / maxDailyMovement) * 100}%` }]} />
                            </View>
                            <Text style={styles.historyDayValue}>{day.incoming + day.outgoing}</Text>
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text style={styles.historyEmpty}>Activity tracking starts with your next inventory change.</Text>
                    )}
                  </Card.Content>
                </Card>
                <View style={styles.dashboardFooter}>
                  <Text style={styles.muted}>Live inventory totals · movement history is recorded from deployment onward.</Text>
                </View>
              </>
            ) : (
              <>
                <View style={styles.pageHeading}>
                  <View style={styles.categoryHeading}>
                    <View style={styles.categoryHeadingIcon}>
                      <MaterialCommunityIcons name={categories.find((entry) => entry.value === category)?.icon as "oil"} size={22} color="#173f35" />
                    </View>
                    <View>
                      <Text variant="headlineMedium" style={styles.pageTitle}>{categories.find((entry) => entry.value === category)?.label}</Text>
                      <Text style={styles.muted}>{visible.length} of {items.filter((item) => item.category === category).length} items</Text>
                    </View>
                  </View>
                  <Button
                    mode="outlined"
                    icon="barcode-scan"
                    compact
                    onPress={() => {
                      if (Platform.OS === "web") return setNotice("Scanning is available on Android and iOS.");
                      if (!permission?.granted) requestPermission();
                      else setScanner(true);
                    }}
                  >Scan</Button>
                </View>
                <View style={[styles.toolbar, !desktop && styles.mobileToolbar]}>
                  <TextInput
                    mode="outlined"
                    placeholder="Search name, brand or barcode"
                    value={search}
                    onChangeText={(value) => {
                      setSearch(value);
                      setInventoryPage(1);
                    }}
                    left={<TextInput.Icon icon="magnify" />}
                    right={search ? <TextInput.Icon icon="close" onPress={() => setSearch("")} /> : undefined}
                    style={[styles.searchInput, !desktop && styles.mobileSearchInput]}
                    contentStyle={styles.searchInputContent}
                    dense
                    accessibilityLabel="Search inventory"
                  />
                  <View style={[styles.toolbarActions, !desktop && styles.mobileActions]}>
                    <Button mode="outlined" icon="barcode-scan" compact onPress={() => openSale()} style={styles.addButton}>Sell</Button>
                    <Button mode="contained-tonal" icon="plus" compact onPress={openNewItem} style={styles.addButton}>Add item</Button>
                  </View>
                </View>
                <View style={styles.list}>
                  {desktop ? (
                    <View style={styles.listHeader}>
                      <Text style={styles.itemHeaderMain}>Item name / brand</Text>
                      <Text style={styles.itemHeaderQty}>Qty</Text>
                      <Text style={styles.itemHeaderAction}>Sell</Text>
                      <Text style={styles.itemHeaderAction}>Edit</Text>
                      <Text style={styles.itemHeaderAction}>Delete</Text>
                    </View>
                  ) : null}
                  {pageItems.map((item) => (
                    <Card key={item.id} style={styles.item}>
                      <Card.Content style={styles.itemContent}>
                        <View style={styles.itemMain}>
                          <Text variant="titleMedium" numberOfLines={1}>{item.name}</Text>
                          <Text style={styles.muted} numberOfLines={1}>
                            {item.brand || "Unbranded"} {item.barcode ? `· ${item.barcode}` : ""}
                          </Text>
                        </View>
                        <Text variant="titleLarge" style={[styles.quantity, item.quantity <= 5 && styles.low]}>{item.quantity}</Text>
                        <IconButton icon="cart-minus" size={19} onPress={() => openSale(item)} accessibilityLabel={`Sell ${item.name}`} />
                        <IconButton
                          icon="pencil"
                          size={19}
                          onPress={() => {
                            setEditing(item);
                            setForm({ name: item.name, brand: item.brand, quantity: String(item.quantity), barcode: item.barcode ?? "", unitPrice: String(item.unitPrice ?? 0) });
                            setModal(true);
                          }}
                          accessibilityLabel="Edit item"
                        />
                        <IconButton icon="delete-outline" size={19} onPress={() => remove(item)} accessibilityLabel="Delete item" />
                      </Card.Content>
                    </Card>
                  ))}
                  {visible.length === 0 ? <Text style={styles.empty}>No items match this category and search.</Text> : null}
                  {visible.length > 0 ? (
                    <View style={styles.pagination}>
                      <Text style={styles.paginationSummary}>
                        Showing {(currentInventoryPage - 1) * pageSize + 1}–{Math.min(currentInventoryPage * pageSize, visible.length)} of {visible.length}
                      </Text>
                      <View style={styles.paginationControls}>
                        <IconButton
                          icon="chevron-left"
                          size={20}
                          mode="outlined"
                          disabled={currentInventoryPage <= 1}
                          onPress={() => setInventoryPage((page) => Math.max(1, page - 1))}
                          accessibilityLabel="Previous inventory page"
                        />
                        <Text style={styles.paginationPage}>Page {currentInventoryPage} of {pageCount}</Text>
                        <IconButton
                          icon="chevron-right"
                          size={20}
                          mode="outlined"
                          disabled={currentInventoryPage >= pageCount}
                          onPress={() => setInventoryPage((page) => Math.min(pageCount, page + 1))}
                          accessibilityLabel="Next inventory page"
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              </>
            )}
          </ScrollView>
        </View>
        {!desktop && mobileDrawer ? (
          <View style={styles.mobileDrawerOverlay}>
            <Pressable style={styles.drawerScrim} onPress={() => setMobileDrawer(false)} />
            <View style={styles.mobileDrawer}>
              <View style={styles.drawerBrand}>
                <Text variant="titleLarge" style={styles.drawerTitle}>Garage<Text style={styles.accent}>Inventory</Text></Text>
                <IconButton icon="close" onPress={() => setMobileDrawer(false)} accessibilityLabel="Close navigation menu" />
              </View>
              {renderNavigation()}
            </View>
          </View>
        ) : null}
        <Portal>
          <Modal
            visible={saleModal}
            onDismiss={() => setSaleModal(false)}
            contentContainerStyle={styles.saleDialog}
          >
            <View style={styles.saleHeading}>
              <View>
                <Text variant="headlineSmall">Sell item</Text>
                <Text style={styles.muted}>Scan or enter the product barcode.</Text>
              </View>
              <IconButton icon="close" onPress={() => setSaleModal(false)} accessibilityLabel="Close sell form" />
            </View>
            <View style={styles.saleBarcodeRow}>
              <TextInput
                label="Barcode number"
                value={saleBarcode}
                onChangeText={setSaleBarcode}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.saleBarcodeInput}
                left={<TextInput.Icon icon="barcode" />}
                onSubmitEditing={() => {
                  if (!saleItem) setNotice("No item matches that barcode.");
                }}
              />
              <IconButton
                icon="barcode-scan"
                mode="contained-tonal"
                size={23}
                onPress={launchSaleScanner}
                accessibilityLabel="Scan product barcode"
              />
            </View>
            {saleBarcode.trim() ? (
              saleItem ? (
                <Card style={styles.saleItemCard}>
                  <Card.Content style={styles.saleItemContent}>
                    <View style={styles.saleItemIcon}>
                      <MaterialCommunityIcons name="package-variant-closed" size={21} color="#173f35" />
                    </View>
                    <View style={styles.saleItemDetails}>
                      <Text variant="titleMedium" numberOfLines={1}>{saleItem.name}</Text>
                      <Text style={styles.muted} numberOfLines={1}>{saleItem.brand || "Unbranded"} · {categories.find((entry) => entry.value === saleItem.category)?.label}</Text>
                    </View>
                    <View style={styles.stockCount}>
                      <Text style={styles.stockCountValue}>{saleItem.quantity}</Text>
                      <Text style={styles.stockCountLabel}>in stock</Text>
                    </View>
                  </Card.Content>
                </Card>
              ) : (
                <Text style={styles.saleNotFound}>No inventory item found with this barcode.</Text>
              )
            ) : (
              <View style={styles.saleLookupHint}>
                <MaterialCommunityIcons name="barcode-scan" size={22} color="#68716e" />
                <Text style={styles.muted}>A matching inventory item will appear here.</Text>
              </View>
            )}
            <Text style={styles.saleQuantityLabel}>Quantity to sell</Text>
            <View style={styles.saleQuantityRow}>
              <IconButton
                icon="minus"
                mode="outlined"
                disabled={Number(saleQuantity) <= 1}
                onPress={() => setSaleQuantity(String(Math.max(1, Number(saleQuantity || 1) - 1)))}
                accessibilityLabel="Decrease sale quantity"
              />
              <TextInput
                mode="outlined"
                value={saleQuantity}
                onChangeText={(value) => setSaleQuantity(value.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                style={styles.saleQuantityInput}
                contentStyle={styles.saleQuantityInputContent}
                dense
                accessibilityLabel="Quantity to sell"
              />
              <IconButton
                icon="plus"
                mode="outlined"
                disabled={!saleItem || Number(saleQuantity) >= saleItem.quantity}
                onPress={() => setSaleQuantity(String(Number(saleQuantity || 0) + 1))}
                accessibilityLabel="Increase sale quantity"
              />
              <Text style={styles.saleAvailable}>{saleItem ? `${saleItem.quantity} available` : ""}</Text>
            </View>
            {saleItem && Number(saleQuantity) > saleItem.quantity ? (
              <Text style={styles.error}>Quantity exceeds current stock.</Text>
            ) : null}
            <Button
              mode="contained"
              icon="cart-check"
              onPress={submitSale}
              disabled={!saleItem || !Number.isInteger(Number(saleQuantity)) || Number(saleQuantity) < 1 || Number(saleQuantity) > saleItem.quantity}
              style={styles.confirmSale}
            >Confirm sale</Button>
          </Modal>
          <Modal
            visible={modal}
            onDismiss={() => setModal(false)}
            contentContainerStyle={styles.dialog}
          >
            <Text variant="headlineSmall">
              {editing ? "Edit item" : "Add inventory item"}
            </Text>
            <TextInput
              label="Item name"
              value={form.name}
              onChangeText={(name) => setForm({ ...form, name })}
              style={styles.input}
            />
            <TextInput
              label="Brand"
              value={form.brand}
              onChangeText={(brand) => setForm({ ...form, brand })}
              style={styles.input}
            />
            <View style={styles.formRow}>
              <TextInput
                label="Quantity"
                keyboardType="number-pad"
                value={form.quantity}
                onChangeText={(quantity) => setForm({ ...form, quantity })}
                style={styles.halfInput}
              />
              <TextInput
                label="Unit price"
                keyboardType="decimal-pad"
                value={form.unitPrice}
                onChangeText={(unitPrice) => setForm({ ...form, unitPrice })}
                style={styles.halfInput}
              />
            </View>
            <TextInput
              label="Barcode / QR value"
              value={form.barcode}
              onChangeText={(barcode) => setForm({ ...form, barcode })}
              style={styles.input}
            />
            <Text style={styles.fieldHelp}>
              Type the number printed below a barcode, or paste the QR value.
              On Android/iPhone, use Scan item to fill this automatically.
            </Text>
            <Button
              mode="contained"
              onPress={save}
              disabled={!form.name.trim()}
            >
              {editing ? "Save changes" : "Add item"}
            </Button>
          </Modal>
          <Dialog visible={scanner} onDismiss={() => setScanner(false)}>
            <Dialog.Title>Scan stock code</Dialog.Title>
            <Dialog.Content>
              {permission?.granted ? (
                <CameraView
                  style={styles.camera}
                  onBarcodeScanned={scan}
                  barcodeScannerSettings={{
                    barcodeTypes: [
                      "qr",
                      "ean13",
                      "ean8",
                      "code128",
                      "upc_a",
                      "upc_e",
                    ],
                  }}
                />
              ) : (
                <Text>Camera access is required to scan.</Text>
              )}
            </Dialog.Content>
          </Dialog>
          <Dialog visible={saleScanner} onDismiss={() => setSaleScanner(false)}>
            <Dialog.Title>Scan item for sale</Dialog.Title>
            <Dialog.Content>
              {permission?.granted ? (
                <CameraView
                  style={styles.camera}
                  onBarcodeScanned={scanSale}
                  barcodeScannerSettings={{
                    barcodeTypes: ["qr", "ean13", "ean8", "code128", "upc_a", "upc_e"],
                  }}
                />
              ) : (
                <Text>Camera access is required to scan.</Text>
              )}
            </Dialog.Content>
          </Dialog>
        </Portal>
        <Snackbar
          visible={!!notice}
          onDismiss={() => setNotice("")}
          duration={2500}
        >
          {notice}
        </Snackbar>
      </View>
    </PaperProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: "#f7f8f6" },
  splash: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#173f35",
  },
  splashIllustration: {
    height: 170,
    width: 220,
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
  },
  sun: { position: "absolute", right: 0, top: 0 },
  splashTitle: { color: "#fff", fontWeight: "700", marginTop: 22 },
  splashSubtitle: { color: "#d6e0db", marginTop: 8, textAlign: "center" },
  splashLoader: {
    width: 220,
    height: 5,
    backgroundColor: "#346252",
    borderRadius: 3,
    marginTop: 38,
    overflow: "hidden",
  },
  splashLoaderFill: {
    width: "55%",
    height: "100%",
    backgroundColor: "#d6a84f",
  },
  splashLoading: { color: "#a9c1b6", marginTop: 12, fontSize: 12 },
  topbar: {
    padding: 22,
    paddingTop: 42,
    backgroundColor: "#173f35",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  topTitle: { color: "#fff", fontWeight: "700" },
  title: { fontWeight: "700" },
  accent: { color: "#d6a84f" },
  muted: { color: "#68716e" },
  login: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#f7f8f6",
  },
  loginCard: {
    marginTop: 28,
    maxWidth: 460,
    width: "100%",
    alignSelf: "center",
    backgroundColor: "#ffffff",
  },
  loginHeading: { color: "#242222", marginBottom: 8 },
  input: { marginVertical: 8, backgroundColor: "#ffffff" },
  error: { color: "#b3261e", marginTop: 12, lineHeight: 20 },
  content: { padding: 20, paddingBottom: 100 },
  desktopContent: { maxWidth: 1180, width: "100%", alignSelf: "center" },
  headingRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
  },
  stats: { flexDirection: "row", gap: 12, marginTop: 22, flexWrap: "wrap" },
  stat: { flex: 1, minWidth: 150, backgroundColor: "#fff" },
  warningStat: { borderLeftWidth: 4, borderLeftColor: "#d6a84f" },
  statLabel: { color: "#68716e", marginBottom: 5 },
  divider: { marginVertical: 24 },
  categoryScroller: { gap: 8, paddingBottom: 16 },
  categoryButton: { borderRadius: 22 },
  toolbar: { flexDirection: "row", gap: 10, alignItems: "center" },
  mobileToolbar: { flexDirection: "column", alignItems: "stretch", gap: 8, marginTop: 14 },
  mobileActions: { width: "100%", justifyContent: "flex-end" },
  toolbarActions: { flexDirection: "row", alignItems: "center", gap: 6 },
  search: { flex: 1, backgroundColor: "#fff" },
  list: { marginTop: 14, gap: 8 },
  listHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 4,
  },
  itemHeaderMain: { flex: 1, color: "#68716e", fontSize: 12 },
  itemHeaderQty: { width: 42, color: "#68716e", fontSize: 12, textAlign: "center" },
  itemHeaderAction: { width: 48, color: "#68716e", fontSize: 11, textAlign: "center" },
  item: { backgroundColor: "#fff" },
  itemContent: { flexDirection: "row", alignItems: "center", gap: 4 },
  itemMain: { flex: 1 },
  low: { color: "#b3261e" },
  empty: { textAlign: "center", color: "#68716e", padding: 40 },
  dialog: { backgroundColor: "#fff", padding: 22, margin: 20, borderRadius: 8 },
  formRow: { flexDirection: "row", gap: 10 },
  halfInput: { flex: 1, marginVertical: 8, backgroundColor: "#fff" },
  fieldHelp: { color: "#68716e", fontSize: 12, lineHeight: 17, marginBottom: 12 },
  camera: { height: 320, width: "100%" },
  fab: { position: "absolute", right: 18, bottom: 18 },
  workspace: { flex: 1, flexDirection: "row" },
  navigation: {
    width: 250,
    paddingHorizontal: 14,
    paddingTop: 22,
    borderRightWidth: 1,
    borderRightColor: "#e1e5e2",
    backgroundColor: "#ffffff",
  },
  navigationLabel: {
    color: "#7b8581",
    fontSize: 10,
    fontWeight: "700",
    letterSpacing: 1,
    paddingHorizontal: 12,
    marginBottom: 8,
  },
  categoryLabel: { marginTop: 24 },
  navigationItem: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 12,
    borderRadius: 6,
    marginBottom: 3,
  },
  navigationItemActive: { backgroundColor: "#e9f0ec" },
  navigationText: { color: "#59615e", fontSize: 14 },
  navigationTextActive: { color: "#173f35", fontWeight: "700" },
  screenContent: {
    flexGrow: 1,
    padding: 24,
    paddingBottom: 48,
    width: "100%",
    maxWidth: 1220,
    alignSelf: "center",
  },
  pageHeading: {
    minHeight: 58,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
  pageTitle: { color: "#242222" },
  chartGrid: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 22 },
  chartCard: { flex: 1, minWidth: 300, backgroundColor: "#ffffff", borderRadius: 8 },
  sectionHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
  },
  chartRows: { gap: 18 },
  chartRow: { gap: 7 },
  chartLabelRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  chartName: { flexDirection: "row", alignItems: "center", gap: 9 },
  chartCategoryName: { color: "#242222", fontSize: 14 },
  chartValue: { color: "#242222", fontSize: 13, fontWeight: "600" },
  barTrack: { height: 9, width: "100%", backgroundColor: "#e9eeeb", borderRadius: 5, overflow: "hidden" },
  barFill: { height: "100%", backgroundColor: "#34745c", borderRadius: 5 },
  chartCaption: { color: "#7b8581", fontSize: 11 },
  mixTrack: { height: 18, flexDirection: "row", overflow: "hidden", borderRadius: 9, backgroundColor: "#e9eeeb" },
  mixSegment: { height: "100%" },
  mixLegend: { gap: 13, marginTop: 22 },
  mixLegendRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  mixSwatch: { width: 10, height: 10, borderRadius: 2 },
  mixLegendLabel: { flex: 1, color: "#59615e", fontSize: 13 },
  mixLegendValue: { color: "#242222", fontSize: 13, fontWeight: "600" },
  historyCard: { marginTop: 16, backgroundColor: "#ffffff", borderRadius: 8 },
  historyLegend: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginBottom: 16 },
  historyLegendItem: { flexDirection: "row", alignItems: "center", gap: 7 },
  historyLegendSwatch: { width: 10, height: 10, borderRadius: 2 },
  incomingSwatch: { backgroundColor: "#34745c" },
  outgoingSwatch: { backgroundColor: "#cf795f" },
  historyRows: { gap: 12 },
  historyDayRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  historyDayLabel: { width: 38, color: "#59615e", fontSize: 12 },
  historyTrack: { flex: 1, minWidth: 80, height: 10, flexDirection: "row", overflow: "hidden", borderRadius: 5, backgroundColor: "#edf0ee" },
  historyBar: { height: "100%" },
  incomingBar: { backgroundColor: "#34745c" },
  outgoingBar: { backgroundColor: "#cf795f" },
  historyDayValue: { width: 30, color: "#59615e", fontSize: 12, textAlign: "right" },
  historyEmpty: { color: "#68716e", paddingVertical: 10 },
  dashboardFooter: { marginTop: 16 },
  categoryHeading: { flexDirection: "row", alignItems: "center", gap: 12 },
  categoryHeadingIcon: {
    width: 42,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    backgroundColor: "#e9f0ec",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    height: 48,
    backgroundColor: "#ffffff",
  },
  mobileSearchInput: { flex: 0, width: "100%", height: 52, paddingVertical: 0 },
  searchInputContent: { minHeight: 46, fontSize: 14 },
  addButton: { minHeight: 42, justifyContent: "center" },
  quantity: { width: 38, textAlign: "center" },
  pagination: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    paddingTop: 8,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#e1e5e2",
  },
  paginationSummary: { flex: 1, color: "#68716e", fontSize: 12 },
  paginationControls: { flexDirection: "row", alignItems: "center", gap: 4 },
  paginationPage: { color: "#59615e", fontSize: 12 },
  rowAction: { width: 40, height: 40, margin: 0 },
  mobileDrawerOverlay: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 10,
    flexDirection: "row",
  },
  drawerScrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.35)" },
  mobileDrawer: { width: 290, maxWidth: "84%", backgroundColor: "#ffffff", elevation: 8 },
  drawerBrand: {
    minHeight: 78,
    paddingLeft: 18,
    paddingRight: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: "#e1e5e2",
  },
  drawerTitle: { color: "#173f35", fontWeight: "700" },
  unlockScreen: {
    flex: 1,
    justifyContent: "center",
    padding: 22,
    backgroundColor: "#f3f6f3",
  },
  unlockBrand: { alignItems: "center", gap: 9, marginBottom: 22 },
  unlockTitle: { color: "#173f35", fontWeight: "700" },
  unlockCard: { width: "100%", maxWidth: 440, alignSelf: "center", backgroundColor: "#ffffff", borderRadius: 8 },
  unlockHeading: { color: "#242222", marginBottom: 6 },
  unlockAction: { marginTop: 12 },
  unlockBiometric: { marginTop: 10 },
  unlockLogout: { marginTop: 8 },
  biometricOption: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: "#e7ebe8",
    marginTop: 4,
  },
  biometricCopy: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 },
  biometricText: { flex: 1 },
  biometricLabel: { color: "#242222", fontSize: 13, fontWeight: "600" },
  lockIcon: {
    width: 54,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 27,
    backgroundColor: "#e9f0ec",
    marginBottom: 16,
  },
  saleDialog: {
    width: "100%",
    maxWidth: 500,
    alignSelf: "center",
    backgroundColor: "#ffffff",
    padding: 22,
    margin: 16,
    borderRadius: 8,
  },
  saleHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  saleBarcodeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14 },
  saleBarcodeInput: { flex: 1, minWidth: 0, backgroundColor: "#ffffff" },
  saleItemCard: { marginTop: 8, backgroundColor: "#f7f9f7", borderRadius: 6 },
  saleItemContent: { flexDirection: "row", alignItems: "center", gap: 10 },
  saleItemIcon: { width: 38, height: 38, alignItems: "center", justifyContent: "center", backgroundColor: "#e9f0ec", borderRadius: 6 },
  saleItemDetails: { flex: 1, minWidth: 0 },
  stockCount: { alignItems: "flex-end" },
  stockCountValue: { color: "#173f35", fontSize: 17, fontWeight: "700" },
  stockCountLabel: { color: "#68716e", fontSize: 10 },
  saleNotFound: { color: "#b3261e", fontSize: 13, paddingVertical: 16 },
  saleLookupHint: { minHeight: 72, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  saleQuantityLabel: { color: "#59615e", fontSize: 13, fontWeight: "600", marginTop: 20 },
  saleQuantityRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 4 },
  saleQuantityInput: { width: 78, height: 44, backgroundColor: "#ffffff" },
  saleQuantityInputContent: { minHeight: 42, textAlign: "center", fontSize: 16 },
  saleAvailable: { flex: 1, color: "#68716e", fontSize: 12, textAlign: "right" },
  confirmSale: { marginTop: 20 },
});
