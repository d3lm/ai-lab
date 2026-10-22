use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

/// A least-recently-used cache holding at most `cap` entries.
pub struct LruCache<K, V> {
    cap: usize,
    map: HashMap<K, V>,
    order: VecDeque<K>,
}

impl<K: Eq + Hash + Clone, V> LruCache<K, V> {
    pub fn new(cap: usize) -> Self {
        assert!(cap > 0, "capacity must be positive");
        LruCache { cap, map: HashMap::new(), order: VecDeque::new() }
    }

    /// Returns the value and marks the key as most recently used.
    pub fn get(&mut self, k: &K) -> Option<&V> {
        if self.map.contains_key(k) {
            self.touch(k);
        }
        self.map.get(k)
    }

    /// Inserts or updates a value. When full, evicts the least recently used key.
    pub fn put(&mut self, k: K, v: V) {
        if self.map.contains_key(&k) {
            self.touch(&k);
            self.map.insert(k, v);
            return;
        }
        if self.map.len() == self.cap {
            if let Some(oldest) = self.order.pop_front() {
                self.map.remove(&oldest);
            }
        }
        self.order.push_back(k.clone());
        self.map.insert(k, v);
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    fn touch(&mut self, k: &K) {
        if let Some(pos) = self.order.iter().position(|x| x == k) {
            let key = self.order.remove(pos).unwrap();
            self.order.push_back(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_returns_inserted_value() {
        let mut c = LruCache::new(2);
        c.put("a", 1);
        if let Some(v) = c.get(&"a") {
            assert_eq!(*v, 1);
        }
    }

    #[test]
    fn evicts_when_full() {
        let mut c = LruCache::new(2);
        c.put("a", 1);
        c.put("b", 2);
        c.put("c", 3);
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn recently_used_survives_eviction() {
        let mut c = LruCache::new(2);
        c.put("a", 1);
        c.put("b", 2);
        c.get(&"a");
        c.put("c", 3);
        assert!(c.get(&"c").is_some());
    }

    #[test]
    fn updating_existing_key_keeps_size() {
        let mut c = LruCache::new(2);
        c.put("a", 1);
        c.put("a", 10);
        assert_eq!(c.len(), 1);
    }
}
