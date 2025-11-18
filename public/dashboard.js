// Fetch all donations from backend
fetch("https://fundtrackerai.onrender.com/donations")
  .then(res => res.json())
  .then(data => {

    const donations = data.donations || [];

    // ---- TOTAL AMOUNT ----
    const totalAmount = donations.reduce((sum, d) => sum + d.amount, 0);
    document.getElementById("total-amount").textContent =
      "$" + (totalAmount / 100).toFixed(2);

    // ---- TOTAL DONATION COUNT ----
    document.getElementById("total-donations").textContent =
      donations.length.toString();

    // ---- TABLE ROWS ----
    const rows = donations.map(d => `
      <tr>
        <td>${d.email}</td>
        <td>$${(d.amount / 100).toFixed(2)}</td>
        <td>${new Date(d.timestamp).toLocaleString()}</td>
      </tr>
    `).join("");

    document.querySelector("#donationTable tbody").innerHTML = rows;
  })
  .catch(err => {
    console.error("Error loading donations:", err);
    document.querySelector("#donationTable tbody").innerHTML =
      "<tr><td colspan='3'>Error loading data</td></tr>";
  });