export interface LineItem {
  sku: string;
  unitCents: number;
  qty: number;
}

export interface Order {
  items: LineItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
}

export interface OrderRepo {
  save(order: Order): Promise<Order>;
}
